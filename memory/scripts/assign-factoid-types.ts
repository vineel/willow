// LLM type-assignment sweep for factoids where factoid_type IS NULL.
// See notes/farley-file-initiative-status.md Phase 5 for context.
//
// Four stages:
//   0. Hard rule — anything from "Logins, Accts, Serials/" path → Account.
//   1. Build allowlist of clean Person/Organization factoids (for reparent).
//   2. Pass 1 — Haiku "assign a type only" for every remaining null-type row.
//      Auto-apply confidence ≥ 0.85. This grows the Person/Org allowlist.
//   3. Pass 2 — Haiku "assign OR demote (with parent_hint)" over anything
//      that pass 1 didn't resolve. Auto-apply confidence ≥ 0.85.
//
// All decisions logged to notes/farley-assessments/type-assignment-<date>.json.
//
//   bun run memory/scripts/assign-factoid-types.ts              # dry-run
//   bun run memory/scripts/assign-factoid-types.ts --apply      # write

import { mkdir } from "node:fs/promises";
import { sql } from "../db";

const APPLY = process.argv.includes("--apply");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const VALID_TYPES = [
  "Person",
  "Place",
  "Organization",
  "Event",
  "Concept",
  "Product",
  "Account",
  "Unknown",
] as const;
type FactoidType = (typeof VALID_TYPES)[number];

// ============================================================================
// 0. Hard rule: rows from Logins/Accts/Serials/ → Account
// ============================================================================

const SERIALS_PATH_PAT = "%/Logins, Accts, Serials/%";

const hardRuleRows = await sql<Array<{ fact_id: string; title: string }>>`
  SELECT f.fact_id, f.title
  FROM app.fact f
  JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
  WHERE f.is_active = true
    AND f.is_factoid = true
    AND f.factoid_type IS NULL
    AND sn.filename LIKE ${SERIALS_PATH_PAT}
`;

console.log(`Hard rule: ${hardRuleRows.length} rows from Logins/Accts/Serials/* → Account`);

if (APPLY && hardRuleRows.length > 0) {
  const ids = hardRuleRows.map((r) => r.fact_id);
  await sql`
    UPDATE app.fact
    SET factoid_type = 'Account'
    WHERE fact_id = ANY(${ids}::uuid[])
  `;
  console.log(`  applied.`);
}

// ============================================================================
// 1. Build clean Person/Organization allowlist
// ============================================================================

async function loadAllowlist(): Promise<
  Array<{ fact_id: string; title: string; factoid_type: string }>
> {
  const rows = await sql<
    Array<{ fact_id: string; title: string; factoid_type: string }>
  >`
    SELECT fact_id, title, factoid_type
    FROM app.fact
    WHERE is_active = true
      AND is_factoid = true
      AND factoid_type IN ('Person', 'Organization')
      AND title IS NOT NULL
      AND title !~ '^\w+''s\s'        -- no possessive fragments
      AND title !~* '(login|password|credentials|tmux|kitty)'
    ORDER BY human_verified DESC, title ASC
  `;
  return rows;
}

// ============================================================================
// Target set loader (post-hard-rule)
// ============================================================================

interface TargetRow {
  fact_id: string;
  title: string;
  content: string;
  keywords: string[] | null;
  source_filename: string | null;
}

async function loadTargets(): Promise<TargetRow[]> {
  return await sql<TargetRow[]>`
    SELECT f.fact_id, f.title, f.content, f.keywords,
           sn.filename AS source_filename
    FROM app.fact f
    LEFT JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
    WHERE f.is_active = true
      AND f.is_factoid = true
      AND f.factoid_type IS NULL
      AND f.title IS NOT NULL
    ORDER BY f.created_at ASC
  `;
}

// ============================================================================
// LLM client
// ============================================================================

const PASS1_SYSTEM = `You are a type-assignment judge for Vineel's personal memory graph.

Every factoid (top-level entity) has a type. You will be shown one factoid
whose type is currently missing. Your job is to assign it.

Valid types and what they mean:
- Person       — a specific real human being
- Place        — a physical location (building, venue, address, city)
- Organization — a company, institution, team, group
- Event        — a specific occurrence bounded in time (an interview, a trip, a meeting)
- Concept      — an abstract idea worth tracking as a first-class entity
- Product      — a named product, service, or tool (software, hardware, SaaS)
- Account      — a credential-bearing relationship to a service (a login, a subscription, a card)
- Unknown      — a legitimate factoid that doesn't fit the other types

You MAY also decide the row is NOT a factoid at all — in which case return
action="demote". Demote is correct when the title looks like:
- an implementation note or heading from a doc ("Lambda Function Details")
- a search query or discussion topic ("SEO and sitemap discussion")
- a tmux/kitty/shell command ("kill tmux window")
- a scratch task or todo ("fix shift-enter in claude code")
- a fragment whose content describes something, not something itself

If you are genuinely unsure, return action="unsure". Do not guess.

Respond with JSON only. No prose.`;

const PASS2_SYSTEM = `${PASS1_SYSTEM}

If you return action="demote" AND the factoid clearly belongs under an
existing parent in the allowlist provided, include the parent's title in
parent_hint EXACTLY as spelled in the allowlist. Otherwise leave
parent_hint null. Do not invent a parent_hint — it must appear in the list.`;

interface Verdict {
  action: "assign" | "demote" | "unsure";
  factoid_type: FactoidType | null;
  parent_hint: string | null;
  confidence: number;
  reason: string;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function buildUserPrompt(
  row: TargetRow,
  allowlist: Array<{ title: string; factoid_type: string }> | null,
): string {
  const lines: string[] = [
    `title: ${row.title}`,
    `content: ${truncate(row.content, 700)}`,
  ];
  if (row.keywords && row.keywords.length > 0) {
    lines.push(`keywords: ${row.keywords.join(", ")}`);
  }
  if (row.source_filename) {
    lines.push(`source_file: ${row.source_filename.replace(/^.*\/Dropbox\/VineelerNotes\//, "")}`);
  }
  const factoid = lines.join("\n");

  if (!allowlist) {
    return `${factoid}

Respond with JSON:
{"action": "assign"|"unsure", "factoid_type": "Person|Place|Organization|Event|Concept|Product|Account|Unknown"|null, "confidence": 0-1, "reason": "<one sentence>"}

(Pass 1: do NOT return demote. Only assign a type, or mark unsure.)`;
  }

  const listStr = allowlist.map((a) => `- ${a.title} [${a.factoid_type}]`).join("\n");
  return `${factoid}

Allowlist of existing clean Person/Organization factoids (for parent_hint on demote):
${listStr}

Respond with JSON:
{"action": "assign"|"demote"|"unsure", "factoid_type": "Person|Place|Organization|Event|Concept|Product|Account|Unknown"|null, "parent_hint": "<allowlist title or null>", "confidence": 0-1, "reason": "<one sentence>"}`;
}

async function callHaiku(
  system: string,
  userPrompt: string,
): Promise<Verdict> {
  const apiKey = process.env.ANTHRO_API_KEY;
  if (!apiKey) throw new Error("ANTHRO_API_KEY not set");

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Haiku ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    content: { type: string; text: string }[];
  };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/, "$1")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<Verdict>;
    const action =
      parsed.action === "assign" || parsed.action === "demote" ? parsed.action : "unsure";
    const factoid_type =
      parsed.factoid_type && (VALID_TYPES as readonly string[]).includes(parsed.factoid_type)
        ? (parsed.factoid_type as FactoidType)
        : null;
    return {
      action,
      factoid_type,
      parent_hint: typeof parsed.parent_hint === "string" ? parsed.parent_hint : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return {
      action: "unsure",
      factoid_type: null,
      parent_hint: null,
      confidence: 0,
      reason: `parse failed: ${cleaned.slice(0, 120)}`,
    };
  }
}

// ============================================================================
// Pass 1: assign-only
// ============================================================================

interface Decision {
  pass: 1 | 2;
  row: TargetRow;
  verdict: Verdict;
  applied: boolean;
  apply_note: string;
}
const decisions: Decision[] = [];

console.log("");
console.log("Loading pass-1 targets...");
const pass1Targets = await loadTargets();
console.log(`  ${pass1Targets.length} null-type factoids`);

console.log("");
console.log("Pass 1 — assign-only...");
let pass1Done = 0;
for (const row of pass1Targets) {
  const verdict = await callHaiku(PASS1_SYSTEM, buildUserPrompt(row, null));
  pass1Done++;
  if (pass1Done % 10 === 0) console.log(`  pass1 ${pass1Done}/${pass1Targets.length}`);

  let applied = false;
  let apply_note = "dry-run";

  if (verdict.action === "assign" && verdict.factoid_type && verdict.confidence >= 0.85) {
    if (APPLY) {
      await sql`UPDATE app.fact SET factoid_type = ${verdict.factoid_type} WHERE fact_id = ${row.fact_id}`;
      applied = true;
      apply_note = `assigned ${verdict.factoid_type}`;
    } else {
      apply_note = `would assign ${verdict.factoid_type}`;
    }
  } else {
    apply_note = `skipped (${verdict.action}, conf ${verdict.confidence.toFixed(2)})`;
  }

  decisions.push({ pass: 1, row, verdict, applied, apply_note });
}

// ============================================================================
// Pass 2: demote or assign, with parent_hint
// ============================================================================

console.log("");
console.log("Loading pass-2 targets + allowlist...");
const pass2Targets = await loadTargets();
const allowlist = await loadAllowlist();
console.log(`  ${pass2Targets.length} remaining null-type factoids`);
console.log(`  ${allowlist.length} allowlist entries`);

// Cap allowlist at 150 to keep per-call tokens in check.
const allowlistCapped = allowlist.slice(0, 150);
const allowlistByTitle = new Map<string, { fact_id: string; factoid_type: string }>();
for (const a of allowlistCapped) {
  allowlistByTitle.set(a.title.toLowerCase().trim(), {
    fact_id: a.fact_id,
    factoid_type: a.factoid_type,
  });
}

console.log("");
console.log("Pass 2 — full decision...");
let pass2Done = 0;
for (const row of pass2Targets) {
  const verdict = await callHaiku(
    PASS2_SYSTEM,
    buildUserPrompt(row, allowlistCapped),
  );
  pass2Done++;
  if (pass2Done % 10 === 0) console.log(`  pass2 ${pass2Done}/${pass2Targets.length}`);

  let applied = false;
  let apply_note = "dry-run";

  if (verdict.confidence < 0.85 || verdict.action === "unsure") {
    apply_note = `skipped (${verdict.action}, conf ${verdict.confidence.toFixed(2)})`;
  } else if (verdict.action === "assign" && verdict.factoid_type) {
    if (APPLY) {
      await sql`UPDATE app.fact SET factoid_type = ${verdict.factoid_type} WHERE fact_id = ${row.fact_id}`;
      applied = true;
      apply_note = `assigned ${verdict.factoid_type}`;
    } else {
      apply_note = `would assign ${verdict.factoid_type}`;
    }
  } else if (verdict.action === "demote") {
    let parentId: string | null = null;
    if (verdict.parent_hint) {
      const found = allowlistByTitle.get(verdict.parent_hint.toLowerCase().trim());
      if (found) parentId = found.fact_id;
    }
    if (APPLY) {
      await sql`
        UPDATE app.fact
        SET is_factoid = false,
            factoid_type = NULL,
            parent_factoid_id = ${parentId}
        WHERE fact_id = ${row.fact_id}
      `;
      applied = true;
      apply_note = parentId ? `demoted → child of ${verdict.parent_hint}` : "demoted";
    } else {
      apply_note = parentId
        ? `would demote → child of ${verdict.parent_hint}`
        : "would demote";
    }
  }

  decisions.push({ pass: 2, row, verdict, applied, apply_note });
}

// ============================================================================
// Summary + audit
// ============================================================================

const counts = {
  assigned: decisions.filter((d) => d.applied && d.verdict.action === "assign").length,
  demoted: decisions.filter((d) => d.applied && d.verdict.action === "demote").length,
  skipped: decisions.filter((d) => !d.applied).length,
};

console.log("");
console.log(`=== Summary (${APPLY ? "APPLIED" : "DRY-RUN"}) ===`);
console.log(`Hard rule: ${APPLY ? hardRuleRows.length : 0} → Account`);
console.log(`Pass 1 + 2 assigned: ${counts.assigned}`);
console.log(`Pass 2 demoted:      ${counts.demoted}`);
console.log(`Skipped (unsure/low-confidence): ${counts.skipped}`);
console.log("");

const typeDist: Record<string, number> = {};
for (const d of decisions) {
  if (d.applied && d.verdict.action === "assign" && d.verdict.factoid_type) {
    typeDist[d.verdict.factoid_type] = (typeDist[d.verdict.factoid_type] ?? 0) + 1;
  }
}
console.log("Assigned type distribution:");
for (const [k, v] of Object.entries(typeDist)) console.log(`  ${k}: ${v}`);
console.log("");

const AUDIT_DIR = `${import.meta.dir}/../../notes/farley-assessments`;
await mkdir(AUDIT_DIR, { recursive: true });
const auditPath = `${AUDIT_DIR}/type-assignment-2026-04-13.json`;
await Bun.write(
  auditPath,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      applied: APPLY,
      hard_rule_count: hardRuleRows.length,
      pass1_count: pass1Targets.length,
      pass2_count: pass2Targets.length,
      allowlist_size: allowlistCapped.length,
      summary: counts,
      type_distribution: typeDist,
      decisions: decisions.map((d) => ({
        pass: d.pass,
        fact_id: d.row.fact_id,
        title: d.row.title,
        source: d.row.source_filename?.replace(/^.*\/Dropbox\/VineelerNotes\//, "") ?? null,
        verdict: d.verdict,
        applied: d.applied,
        note: d.apply_note,
      })),
    },
    null,
    2,
  ),
);
console.log(`Audit written to ${auditPath}`);

await sql.end();
