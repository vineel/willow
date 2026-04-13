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

You will be shown one email. Decide whether it contains durable personal
facts about Vineel, his family, his ongoing projects, or people and
organizations in his circle that are worth remembering a year from now.

Say YES when the email contains things like:
- a person's contact info, role, relationship, or meaningful biographical context
- a decision, commitment, or plan Vineel has made
- a recurring event, appointment, or schedule item
- project context — Accordli, Willow, side projects
- medical, financial, or legal context worth tracking

Say NO for transactional, automated, or purely ephemeral content:
- order confirmations, shipping notifications, receipts
- newsletters, marketing, promotions
- 2FA codes, verification emails
- social network notifications
- calendar invitations that repeat identical info
- no-reply automated alerts that aren't novel

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
  const apiKey = process.env.ANTHRO_API_KEY;
  if (!apiKey) throw new Error("ANTHRO_API_KEY not set");

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
    let costPrefilter = 0;
    const yesExamples: Array<{ subject: string; from: string; reason: string }> = [];

    for (let i = 0; i < ids.length; i += PAGE) {
      const batch = ids.slice(i, i + PAGE);
      const emails = await getEmails(session, token, batch);
      fetched += emails.length;

      for (const email of emails) {
        const event = normalize(email);
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
        try {
          const bodyText = event.bodyText;
          const pf = await prefilter(email, bodyText);
          prefilterCalls++;
          costPrefilter += estimateCost(1, 0, args.extractionModel).prefilter;
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

        // Stage 2: extraction would happen here for prefilterYes emails.
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
            cost_prefilter = ${costPrefilter}
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
      console.log(
        "NOTE: extraction + memory writes are not yet implemented (stage 2).",
      );
      console.log(
        "      re-run with --dry-run to suppress this notice.",
      );
    }

    await sql`
      UPDATE app.bootstrap_run
      SET status = 'completed',
          ended_at = now(),
          cost_prefilter = ${est.prefilter}
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
