// Bootstrap Memory from historical email.
// See notes/bootstrap-memory-plan.md for design and rationale.
//
// Pipeline:
//   JMAP fetch (oldest → newest)
//     → triage (field rules, no LLM)
//     → fact-worth pre-filter (Haiku, cached system prompt)
//     → extraction (Sonnet, narrow prompt)        [stage 2]
//     → dedupe vs existing memory + memory_add    [stage 2]
//
// Stage 1 (this commit): scaffold + dry-run + pre-filter pass working end
// to end. Extraction is stubbed and --apply intentionally disabled until
// stage 2 lands, so nothing writes facts yet.
//
// Usage:
//   bun run pib:bootstrap-memory -- --count 2000 --dry-run
//   bun run pib:bootstrap-memory -- --since 2024-01-01 --until 2025-12-31
//   bun run pib:bootstrap-memory -- --count 2000 --resume
//
// Flags (all parsed below):
//   --count N                    fetch most recent N emails, process oldest first
//   --since YYYY-MM-DD           date range start (overrides --count)
//   --until YYYY-MM-DD           date range end
//   --dry-run                    triage + pre-filter only, no extraction / writes
//   --max-prefilter-calls N      hard cap, default 2000
//   --max-extraction-calls N     hard cap, default 300
//   --extraction-model MODEL     sonnet | opus, default sonnet
//   --resume                     continue from last run's last_jmap_id
//   --verbose                    log per-email decisions

import { sql, getSecret } from "../config";
import { getSession, getMailboxes, findMailbox } from "../jmap/session";
import { jmapRequest } from "../jmap/client";
import { getEmails } from "../jmap/query";
import type { JMAPEmail, JMAPSession } from "../jmap/types";
import { normalize } from "../normalizer";
import { triage } from "../triage/engine";
import { loadRules } from "../triage/rules";
import { generateEmbedding } from "../../memory/lmstudio/client";

// ============================================================================
// Args
// ============================================================================

interface Args {
  count: number;
  since: string | null;
  until: string | null;
  dryRun: boolean;
  maxPrefilter: number;
  maxExtraction: number;
  extractionModel: "sonnet" | "opus";
  resume: boolean;
  verbose: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  const model = get("--extraction-model") ?? "sonnet";
  if (model !== "sonnet" && model !== "opus") {
    throw new Error(`--extraction-model must be sonnet or opus, got "${model}"`);
  }
  return {
    count: parseInt(get("--count") ?? "2000", 10),
    since: get("--since") ?? null,
    until: get("--until") ?? null,
    dryRun: has("--dry-run"),
    maxPrefilter: parseInt(get("--max-prefilter-calls") ?? "2000", 10),
    maxExtraction: parseInt(get("--max-extraction-calls") ?? "300", 10),
    extractionModel: model,
    resume: has("--resume"),
    verbose: has("--verbose"),
  };
}

const args = parseArgs();

// ============================================================================
// Cost model
// ============================================================================

// Very rough, conservative estimates. The real per-call cost depends on
// actual token counts and cache behavior — these are for up-front budget
// reporting in --dry-run only.
const HAIKU_INPUT_PER_M = 1.0;      // $/M tokens
const HAIKU_OUTPUT_PER_M = 5.0;
const SONNET_INPUT_PER_M = 3.0;
const SONNET_OUTPUT_PER_M = 15.0;
const OPUS_INPUT_PER_M = 15.0;
const OPUS_OUTPUT_PER_M = 75.0;

const PREFILTER_TOKENS_IN = 1500;
const PREFILTER_TOKENS_OUT = 60;
const EXTRACTION_TOKENS_IN = 2200;
const EXTRACTION_TOKENS_OUT = 500;

function estimateCost(prefilterCalls: number, extractionCalls: number, model: "sonnet" | "opus") {
  const prefilter =
    (prefilterCalls * PREFILTER_TOKENS_IN * HAIKU_INPUT_PER_M) / 1e6 +
    (prefilterCalls * PREFILTER_TOKENS_OUT * HAIKU_OUTPUT_PER_M) / 1e6;
  const inPer = model === "opus" ? OPUS_INPUT_PER_M : SONNET_INPUT_PER_M;
  const outPer = model === "opus" ? OPUS_OUTPUT_PER_M : SONNET_OUTPUT_PER_M;
  const extraction =
    (extractionCalls * EXTRACTION_TOKENS_IN * inPer) / 1e6 +
    (extractionCalls * EXTRACTION_TOKENS_OUT * outPer) / 1e6;
  return { prefilter, extraction, total: prefilter + extraction };
}

// ============================================================================
// JMAP: fetch candidate email ids (oldest → newest)
// ============================================================================

async function fetchCandidateIds(
  session: JMAPSession,
  token: string,
): Promise<string[]> {
  // Query all mailboxes — we want historical reach, not a specific folder.
  // Filter by date range if --since/--until given; otherwise take the most
  // recent N from everywhere and reverse to oldest-first.
  const filter: Record<string, unknown> = {};
  if (args.since) filter.after = new Date(args.since).toISOString();
  if (args.until) filter.before = new Date(args.until).toISOString();

  // Sort ASC so pages come out oldest-first — matches the plan's "oldest
  // → newest" processing order, important for contradictions (newer
  // writes overwrite older).
  const sortAscending = args.since !== null || args.until !== null;

  const limit = args.count;

  const response = await jmapRequest(session.apiUrl, token, [
    [
      "Email/query",
      {
        accountId: session.accountId,
        filter,
        sort: [{ property: "receivedAt", isAscending: sortAscending }],
        limit,
      },
      "q1",
    ],
  ]);

  const [, result] = response.methodResponses[0];
  const ids = result.ids as string[];

  // When we sorted DESC (no date range, --count mode), reverse so oldest
  // is first.
  if (!sortAscending) ids.reverse();
  return ids;
}

// ============================================================================
// Resume support
// ============================================================================

async function findResumePoint(): Promise<{
  run_id: string;
  last_jmap_id: string | null;
} | null> {
  const [row] = await sql`
    SELECT run_id, last_jmap_id
    FROM app.bootstrap_run
    WHERE status IN ('running', 'failed', 'budget_exceeded', 'aborted')
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return row ? { run_id: row.run_id, last_jmap_id: row.last_jmap_id } : null;
}

// ============================================================================
// Pre-filter (Haiku)
// ============================================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const PREFILTER_SYSTEM = `You are a pre-filter for Vineel Shah's personal memory bootstrap.

Vineel's circle is his wife Stephanie, his kids Zeph and Ele, his parents
Vinod and Neela, his brother Nigam and family, the Sokaris in-laws, and
his Accordli co-founder Brad Simon. His ongoing projects are Accordli (AI
contracting workbench for lawyers) and Willow (this memory system). He
does not currently hold a day job.

You will be shown one email. Decide whether it contains durable personal
facts about Vineel, his immediate circle, his ongoing projects, or
active professional relationships that will still matter in a year.

Say YES when the email contains things like:
- a specific person in Vineel's circle sharing contact info, a decision,
  a medical/financial/legal update, or a concrete plan
- a confirmed event Vineel or a family member RSVP'd to or committed to
- Accordli / Willow project context from Brad or other collaborators
- a received payment, invoice, or financial commitment for a real
  engagement Vineel is actually doing work for
- school / college / medical communications about Zeph, Ele, or his
  parents (Vinod, Neela)

Say NO — the following NEVER qualify even when they sound important:

- Cold-outreach investment pitches, "family office interest", inbound
  sales DMs from unknown senders. Scammy domains ("trustedstockdesk.help",
  "*.xyz", look-alike fintech brands) are ALWAYS NO even when the subject
  name-drops Vineel. Treat these as spam.
- Marketing newsletters and substacks — including ones where the AUTHOR
  shares their own travel, visa status, life update, or meetup plans.
  Vineel is not personally close to these authors; their life is not
  his memory. NO regardless of how warm the email sounds.
- Automated event invitations (tech meetups, vendor breakfasts, webinars,
  conferences) that Vineel has NOT explicitly accepted. A calendar invite
  in the body is not evidence of attendance.
- Emails from Willow itself — anything whose sender is
  "willow-notification@vineel.com" or whose subject starts with "Willow:".
  These are derivative summaries OF memory, not new input. NEVER YES.
- Daily digests, roundups, "here's what's new" style automated summaries.
- Order confirmations, shipping notifications, receipts for e-commerce
  purchases, 2FA codes, verification links, social network notifications.

Bias toward NO. A borderline email should be NO — the extraction stage
is expensive and false positives are more costly than false negatives.

Respond with JSON only:
{"worth": true|false, "reason": "<one short sentence>"}`;

interface PrefilterVerdict {
  worth: boolean;
  reason: string;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function emailToPrompt(email: JMAPEmail, bodyText: string | undefined): string {
  const from = email.from?.[0];
  const fromStr = from
    ? from.name
      ? `${from.name} <${from.email}>`
      : from.email
    : "unknown";
  const subject = email.subject ?? "(no subject)";
  const body = truncate(bodyText ?? "(no text body)", 1500);
  return `from: ${fromStr}
subject: ${subject}
date: ${email.receivedAt}
body:
${body}`;
}

async function prefilter(
  email: JMAPEmail,
  bodyText: string | undefined,
): Promise<PrefilterVerdict> {
  const apiKey = await getSecret("ANTHRO_API_KEY");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: PREFILTER_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: emailToPrompt(email, bodyText) }],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Haiku prefilter ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { content: { type: string; text: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/, "$1")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as PrefilterVerdict;
    return {
      worth: parsed.worth === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return { worth: false, reason: `parse failed: ${cleaned.slice(0, 80)}` };
  }
}

// ============================================================================
// Extraction (Sonnet)
// ============================================================================

const SONNET_MODEL = "claude-sonnet-4-6";
const OPUS_MODEL = "claude-opus-4-6";

const EXTRACTION_SYSTEM = `You are extracting durable memory facts from
Vineel Shah's historical email for his personal memory graph.

Vineel's circle: wife Stephanie Sokaris, son Zeph (Zephyros), child Ele
(Elektra, they/them), parents Vinod and Neela, brother Nigam and his
family (Heidi, Arjun, Priya), Sokaris in-laws in Albany (Mary, Stratton,
Roxanne, Ryleigh, Zoe, James, Sandra), Accordli co-founder Brad Simon.
Ongoing projects: Accordli (AI contracting workbench for lawyers) and
Willow (this memory system).

For the email shown, produce atomic facts worth remembering a year from
now. Each fact is a short sentence about one distinct piece of
information. Phrase time-sensitive content relative to the email date
("Zeph was accepted to X in April 2026"), not as present tense.

Only emit facts about:
- People in Vineel's circle (biographical details, roles, contact info,
  decisions, plans, health)
- Accordli / Willow project context (design decisions, milestones,
  partners, features)
- Concrete commitments, appointments, decisions Vineel or his family
  have actually made
- Active professional relationships — someone who's actively engaged
  with Vineel on real work

DO NOT emit facts about:
- 2FA codes, order numbers, tracking numbers, verification codes
- Marketing content, newsletter editorials, promotional material
- Cold outreach from unknown senders even if it sounds real
- Things the sender speculated might happen but weren't committed
- Dates of events Vineel didn't actually attend or RSVP to

Each fact has:
- title: short name, 3-8 words
- content: one or two complete sentences with date context
- is_factoid: true if this fact describes a distinct real-world entity
  (a Person, Place, Organization, Event, Product, Account) that might
  accumulate child facts later. false for individual statements about
  an existing entity.
- factoid_type: one of Person, Place, Organization, Event, Concept,
  Product, Account, Unknown — or null if is_factoid is false
- keywords: 3-6 search terms

If the email has no such facts, return an empty facts array.

Respond with JSON only:
{"facts": [{"title": "...", "content": "...", "is_factoid": true|false, "factoid_type": "..."|null, "keywords": ["...", ...]}]}`;

interface ExtractedFact {
  title: string;
  content: string;
  is_factoid: boolean;
  factoid_type: string | null;
  keywords: string[];
}

async function extractFacts(
  email: JMAPEmail,
  bodyText: string | undefined,
  model: "sonnet" | "opus",
): Promise<ExtractedFact[]> {
  const apiKey = await getSecret("ANTHRO_API_KEY");

  const modelId = model === "opus" ? OPUS_MODEL : SONNET_MODEL;
  const userPrompt = emailToPrompt(email, bodyText);

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: EXTRACTION_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${modelId} ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { content: { type: string; text: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/, "$1")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as { facts?: unknown };
    if (!parsed.facts || !Array.isArray(parsed.facts)) return [];
    const valid = (["Person", "Place", "Organization", "Event", "Concept", "Product", "Account", "Unknown"] as const);
    const out: ExtractedFact[] = [];
    for (const f of parsed.facts) {
      if (!f || typeof f !== "object") continue;
      const r = f as Record<string, unknown>;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      const content = typeof r.content === "string" ? r.content.trim() : "";
      if (!title || !content) continue;
      const is_factoid = r.is_factoid === true;
      const factoid_type =
        typeof r.factoid_type === "string" && (valid as readonly string[]).includes(r.factoid_type)
          ? r.factoid_type
          : null;
      const keywords = Array.isArray(r.keywords)
        ? r.keywords.filter((k): k is string => typeof k === "string")
        : [];
      out.push({ title, content, is_factoid, factoid_type, keywords });
    }
    return out;
  } catch {
    console.log(`[extract] parse failed on ${email.id}: ${cleaned.slice(0, 100)}`);
    return [];
  }
}

// ============================================================================
// Memory write path (thin bootstrap-specific helper)
// ============================================================================

// Dedupe threshold for memory_search: if an existing fact's cosine
// similarity to a candidate is >= this, we skip the insert.
const SEMANTIC_DUP_THRESHOLD = 0.88;

async function semanticDuplicateExists(
  embedding: number[],
): Promise<boolean> {
  const lit = `[${embedding.join(",")}]`;
  const rows = await sql`
    SELECT 1 - (embedding <=> ${lit}::vector) AS score
    FROM app.fact
    WHERE is_active = true AND embedding IS NOT NULL
    ORDER BY embedding <=> ${lit}::vector
    LIMIT 1
  `;
  if (rows.length === 0) return false;
  return (rows[0] as { score: number }).score >= SEMANTIC_DUP_THRESHOLD;
}

async function saveSourceNoteForEmail(
  email: JMAPEmail,
  bodyText: string | undefined,
  summary: string | null,
): Promise<string> {
  const from = email.from?.[0];
  const fromStr = from
    ? from.name
      ? `${from.name} <${from.email}>`
      : from.email
    : "unknown";
  const rawText = `From: ${fromStr}
Subject: ${email.subject ?? "(no subject)"}
Date: ${email.receivedAt}

${bodyText ?? ""}`;

  const metadata = {
    from: fromStr,
    from_address: from?.email ?? null,
    subject: email.subject ?? null,
    date: email.receivedAt,
    thread_id: email.threadId,
    mailbox_ids: email.mailboxIds,
    bootstrap: true,
  };

  const [row] = await sql<Array<{ source_note_id: string }>>`
    INSERT INTO app.source_note
      (source_type, source_ref, original_id, title, raw_text, summary,
       extracted_by, metadata, received_at)
    VALUES (
      'email',
      ${email.id},
      ${email.id},
      ${email.subject ?? "(no subject)"},
      ${rawText},
      ${summary},
      'sonnet',
      ${sql.json(metadata as unknown as Record<string, unknown>)},
      ${email.receivedAt}
    )
    ON CONFLICT (source_type, source_ref) WHERE source_ref IS NOT NULL
      DO UPDATE SET raw_text = EXCLUDED.raw_text
    RETURNING source_note_id
  `;
  return row.source_note_id;
}

interface BootstrapWriteResult {
  attempted: number;
  written: number;
  skipped_semantic: number;
  skipped_title: number;
}

async function bootstrapSaveFacts(
  email: JMAPEmail,
  bodyText: string | undefined,
  facts: ExtractedFact[],
): Promise<BootstrapWriteResult> {
  const result: BootstrapWriteResult = {
    attempted: facts.length,
    written: 0,
    skipped_semantic: 0,
    skipped_title: 0,
  };
  if (facts.length === 0) return result;

  // Single source_note per email, shared across all facts.
  const summary = facts[0]?.content ?? null;
  const sourceNoteId = await saveSourceNoteForEmail(email, bodyText, summary);

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];

    // Embed content for semantic dedupe + vector search later.
    const { embedding } = await generateEmbedding(
      `${fact.title}\n${fact.content}`,
    );
    const vecLit = `[${embedding.join(",")}]`;

    // Semantic dedupe — if a near-duplicate exists, skip.
    if (await semanticDuplicateExists(embedding)) {
      result.skipped_semantic++;
      continue;
    }

    // On-insert exact-title dedupe (mirror of memory/extractor/extract.ts).
    let is_factoid = fact.is_factoid;
    let factoid_type: string | null = fact.factoid_type;
    let parent_factoid_id: string | null = null;
    if (fact.is_factoid && fact.factoid_type) {
      const [existing] = await sql`
        SELECT fact_id FROM app.fact
        WHERE is_active = true AND is_factoid = true
          AND factoid_type = ${fact.factoid_type}
          AND lower(btrim(title)) = ${fact.title.toLowerCase().trim()}
        LIMIT 1
      `;
      if (existing) {
        is_factoid = false;
        factoid_type = null;
        parent_factoid_id = existing.fact_id;
        result.skipped_title++;
      }
    }

    await sql`
      INSERT INTO app.fact (
        source_note_id, source_ordinal, title, content, keywords,
        embedding, memory_type, status, is_factoid, factoid_type,
        parent_factoid_id, confidence, expires_type
      ) VALUES (
        ${sourceNoteId}, ${i + 1}, ${fact.title}, ${fact.content},
        ${fact.keywords}, ${vecLit}::vector, 'long_term', 'clustered',
        ${is_factoid}, ${factoid_type}, ${parent_factoid_id}, 0.7, 'never'
      )
    `;
    result.written++;
  }

  return result;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("");
  console.log("=== Bootstrap Memory ===");
  console.log(
    `mode:           ${args.dryRun ? "DRY-RUN" : "(extraction stage not yet implemented)"}`,
  );
  console.log(
    `scope:          ${args.since || args.until ? `${args.since ?? "-∞"} → ${args.until ?? "now"}` : `last ${args.count} emails`}`,
  );
  console.log(
    `caps:           prefilter ${args.maxPrefilter}, extraction ${args.maxExtraction}`,
  );
  console.log(`extract model:  ${args.extractionModel}`);
  console.log("");

  const token = await getSecret("fastmail-token");
  const session = await getSession(token);

  // Resume handling.
  let resumeFromId: string | null = null;
  if (args.resume) {
    const prev = await findResumePoint();
    if (prev?.last_jmap_id) {
      resumeFromId = prev.last_jmap_id;
      console.log(`[resume] picking up after ${resumeFromId} (from run ${prev.run_id})`);
    } else {
      console.log("[resume] no prior run found — starting fresh");
    }
  }

  // Start a run row.
  const [run] = await sql<Array<{ run_id: string }>>`
    INSERT INTO app.bootstrap_run (args, status)
    VALUES (${sql.json(args as unknown as Record<string, unknown>)}, 'running')
    RETURNING run_id
  `;
  const runId = run.run_id;
  console.log(`[run] ${runId}`);

  const startTime = Date.now();

  try {
    // 1. Fetch candidate ids.
    console.log("");
    console.log("[fetch] querying JMAP for candidate ids...");
    const allIds = await fetchCandidateIds(session, token);
    console.log(`[fetch] ${allIds.length} candidate ids`);

    // Apply resume filter.
    let ids = allIds;
    if (resumeFromId) {
      const idx = ids.indexOf(resumeFromId);
      if (idx >= 0) ids = ids.slice(idx + 1);
    }

    // 2. Walk in pages of 50.
    const PAGE = 50;
    const rules = await loadRules();
    console.log(`[triage] loaded ${rules.length} rules`);

    let fetched = 0;
    let triaged = 0;
    let survived = 0;
    let prefilterCalls = 0;
    let prefilterYes = 0;
    let extractionCalls = 0;
    let factsWritten = 0;
    let factsSkippedSemantic = 0;
    let factsSkippedTitle = 0;
    let costPrefilter = 0;
    let costExtraction = 0;
    const yesExamples: Array<{ subject: string; from: string; reason: string }> = [];

    for (let i = 0; i < ids.length; i += PAGE) {
      const batch = ids.slice(i, i + PAGE);
      const emails = await getEmails(session, token, batch);
      fetched += emails.length;

      for (const email of emails) {
        const event = normalize(email);

        // Hard skip Willow's own notification emails — derivative of
        // memory, not input to it. Belt-and-suspenders alongside the
        // prompt rule, since the prompt isn't load-bearing for things
        // we can match mechanically.
        const fromAddr = event.fromEntity.address.toLowerCase();
        if (
          fromAddr === "willow-notification@vineel.com" ||
          (email.subject ?? "").startsWith("Willow:")
        ) {
          triaged++;
          if (args.verbose) {
            console.log(`  SKIP   ${email.subject?.slice(0, 60) ?? ""}  (willow self)`);
          }
          continue;
        }

        const verdict = triage(event, rules);
        triaged++;
        if (verdict.action === "noise") {
          if (args.verbose) {
            console.log(`  NOISE  ${email.subject?.slice(0, 60) ?? ""}  (${verdict.rule_name ?? verdict.source})`);
          }
          continue;
        }
        survived++;

        // Pre-filter.
        if (prefilterCalls >= args.maxPrefilter) {
          console.log(`[budget] prefilter cap reached (${args.maxPrefilter}) — stopping`);
          await sql`UPDATE app.bootstrap_run SET status = 'budget_exceeded' WHERE run_id = ${runId}`;
          break;
        }
        let pfWorth = false;
        try {
          const bodyText = event.bodyText;
          const pf = await prefilter(email, bodyText);
          prefilterCalls++;
          costPrefilter += estimateCost(1, 0, args.extractionModel).prefilter;
          pfWorth = pf.worth;
          if (pf.worth) {
            prefilterYes++;
            if (yesExamples.length < 20) {
              const from = email.from?.[0];
              yesExamples.push({
                subject: email.subject ?? "",
                from: from ? `${from.name ?? ""} <${from.email}>` : "(unknown)",
                reason: pf.reason,
              });
            }
            if (args.verbose) {
              console.log(`  YES    ${email.subject?.slice(0, 60) ?? ""}  — ${pf.reason}`);
            }
          } else if (args.verbose) {
            console.log(`  no     ${email.subject?.slice(0, 60) ?? ""}  — ${pf.reason}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[prefilter] error on ${email.id}: ${msg}`);
        }

        if (!pfWorth) continue;
        if (args.dryRun) continue;

        // Stage 2: extraction + memory write.
        if (extractionCalls >= args.maxExtraction) {
          console.log(`[budget] extraction cap reached (${args.maxExtraction}) — continuing prefilter only`);
          continue;
        }
        try {
          const bodyText = event.bodyText;
          const facts = await extractFacts(email, bodyText, args.extractionModel);
          extractionCalls++;
          costExtraction += estimateCost(0, 1, args.extractionModel).extraction;
          if (facts.length === 0) {
            if (args.verbose) console.log(`  EXTRACT  ${email.subject?.slice(0, 60) ?? ""}  (0 facts)`);
            continue;
          }
          const write = await bootstrapSaveFacts(email, bodyText, facts);
          factsWritten += write.written;
          factsSkippedSemantic += write.skipped_semantic;
          factsSkippedTitle += write.skipped_title;
          console.log(
            `  WROTE  ${email.subject?.slice(0, 50) ?? ""}  (${write.written}/${write.attempted}, sem-skip ${write.skipped_semantic}, title-snap ${write.skipped_title})`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[extract] error on ${email.id}: ${msg}`);
        }
      }

      // Checkpoint after each page.
      await sql`
        UPDATE app.bootstrap_run
        SET last_jmap_id = ${batch[batch.length - 1]},
            emails_fetched = ${fetched},
            emails_triaged = ${triaged},
            emails_survived = ${survived},
            prefilter_calls = ${prefilterCalls},
            prefilter_yes = ${prefilterYes},
            extraction_calls = ${extractionCalls},
            facts_added = ${factsWritten},
            cost_prefilter = ${costPrefilter},
            cost_extraction = ${costExtraction}
        WHERE run_id = ${runId}
      `;

      console.log(
        `[progress] ${fetched}/${ids.length}  triaged=${triaged}  survived=${survived}  prefilter_yes=${prefilterYes}`,
      );
    }

    // Final.
    const est = estimateCost(
      prefilterCalls,
      Math.min(prefilterYes, args.maxExtraction),
      args.extractionModel,
    );

    console.log("");
    console.log("=== Bootstrap Memory — results ===");
    console.log(`Fetched:         ${fetched}`);
    console.log(`Triaged:         ${triaged}`);
    console.log(
      `Survived triage: ${survived}  (${pct(survived, triaged)}% of triaged)`,
    );
    console.log(
      `Prefilter yes:   ${prefilterYes}  (${pct(prefilterYes, prefilterCalls)}% of prefiltered, ${pct(prefilterYes, triaged)}% of all)`,
    );
    console.log("");
    console.log("Cost estimates (if extraction stage were run):");
    console.log(`  prefilter:   $${est.prefilter.toFixed(3)}  (${prefilterCalls} calls, actual)`);
    console.log(
      `  extraction:  $${est.extraction.toFixed(3)}  (~${Math.min(prefilterYes, args.maxExtraction)} ${args.extractionModel} calls)`,
    );
    console.log(`  total:       $${est.total.toFixed(3)}`);
    console.log("");

    if (yesExamples.length > 0) {
      console.log(`Sample "yes" decisions (first ${yesExamples.length}):`);
      for (const y of yesExamples) {
        console.log(`  ${y.subject.slice(0, 70)}`);
        console.log(`    from: ${y.from}`);
        console.log(`    why:  ${y.reason}`);
      }
      console.log("");
    }

    const durationSec = (Date.now() - startTime) / 1000;
    console.log(`Elapsed: ${durationSec.toFixed(1)}s`);
    console.log("");

    if (!args.dryRun) {
      console.log("Extraction + writes:");
      console.log(`  extraction calls:    ${extractionCalls}`);
      console.log(`  facts written:       ${factsWritten}`);
      console.log(`  skipped (semantic):  ${factsSkippedSemantic}`);
      console.log(`  skipped (title):     ${factsSkippedTitle} (snapped to existing factoid as child)`);
      console.log(`  actual extraction $: $${costExtraction.toFixed(3)}`);
      console.log("");
    }

    await sql`
      UPDATE app.bootstrap_run
      SET status = 'completed',
          ended_at = now(),
          cost_prefilter = ${costPrefilter},
          cost_extraction = ${costExtraction},
          extraction_calls = ${extractionCalls},
          facts_added = ${factsWritten}
      WHERE run_id = ${runId}
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] error: ${msg}`);
    await sql`
      UPDATE app.bootstrap_run
      SET status = 'failed', ended_at = now(), error = ${msg}
      WHERE run_id = ${runId}
    `;
    throw err;
  } finally {
    await sql.end();
  }
}

function pct(num: number, den: number): string {
  if (den === 0) return "0";
  return ((100 * num) / den).toFixed(0);
}

await main();
