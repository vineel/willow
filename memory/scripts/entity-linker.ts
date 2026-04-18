// Entity linker — find and merge duplicate Person factoids.
//
// Problem: extractions from different notes use different aliases (first
// name only, nickname, typo, full name), and the on-insert dedupe only
// catches exact-title matches. Result: "Jer" / "Jeremiah" / "Jeremiah Wilton"
// end up as three separate Person factoids.
//
// Strategy:
//   1. Load all active Person factoids (+ child fact previews for context).
//   2. Build candidate merge pairs using three cheap pre-filters:
//        a. first-token equality: "Anil" vs "Anil Kumar Garikepati"
//        b. proper-prefix / contained: "Jer" vs "Jeremiah Wilton"
//        c. trigram similarity ≥ 0.5: "Arvnidh Krishnaswarmy" vs "Arvindh Krishnaswamy"
//   3. For each candidate pair, ask Haiku: "Are X and Y the same person?"
//      with child-fact context for disambiguation.
//   4. On same=true AND confidence ≥ MIN_CONFIDENCE, merge:
//        - pick winner (more tokens, more children)
//        - move child facts to winner
//        - move fact_relationships to winner (handle unique conflicts)
//        - deactivate loser
//   5. Audit every decision to notes/farley-assessments/.
//
// Run:
//   bun run memory/scripts/entity-linker.ts               # dry-run
//   bun run memory/scripts/entity-linker.ts --apply
//   bun run memory/scripts/entity-linker.ts --apply --min-confidence 0.8

import { mkdir } from "node:fs/promises";
import { sql } from "../db";

const APPLY = process.argv.includes("--apply");

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}
const MIN_CONFIDENCE = Number(argValue("--min-confidence") ?? "0.85");
const TRIGRAM_THRESHOLD = Number(argValue("--trigram-threshold") ?? "0.5");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// ============================================================================
// Load people and their child-fact previews
// ============================================================================

interface Person {
  fact_id: string;
  title: string;
  created_at: Date;
  kid_count: number;
  kid_preview: string[];
}

const peopleRaw = await sql<Array<{ fact_id: string; title: string; created_at: Date }>>`
  SELECT fact_id, title, created_at
  FROM app.fact
  WHERE is_active = true
    AND is_factoid = true
    AND factoid_type = 'Person'
    AND title IS NOT NULL
  ORDER BY lower(btrim(title))
`;

const kidRows = await sql<Array<{ parent_factoid_id: string; title: string | null; content: string }>>`
  SELECT parent_factoid_id, title, content
  FROM app.fact
  WHERE is_active = true
    AND is_factoid = false
    AND parent_factoid_id IN ${sql(peopleRaw.map((p) => p.fact_id))}
  ORDER BY parent_factoid_id, created_at
`;

const kidsByParent = new Map<string, string[]>();
for (const k of kidRows) {
  const preview = (k.title || k.content).slice(0, 140);
  const arr = kidsByParent.get(k.parent_factoid_id) ?? [];
  arr.push(preview);
  kidsByParent.set(k.parent_factoid_id, arr);
}

const people: Person[] = peopleRaw.map((p) => {
  const kids = kidsByParent.get(p.fact_id) ?? [];
  return { ...p, kid_count: kids.length, kid_preview: kids.slice(0, 5) };
});

console.log(`[entity-linker] loaded ${people.length} active Person factoids`);
console.log(`[entity-linker] mode: ${APPLY ? "APPLY" : "DRY-RUN"} · min_confidence=${MIN_CONFIDENCE}`);

// ============================================================================
// Candidate pair generation
// ============================================================================

function firstToken(title: string): string {
  return title.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function tokens(title: string): string[] {
  return title.trim().split(/\s+/);
}

interface Candidate {
  a: Person;
  b: Person;
  reason: string;
}

const pairs = new Map<string, Candidate>();
function addPair(a: Person, b: Person, reason: string) {
  if (a.fact_id === b.fact_id) return;
  const [lo, hi] = a.fact_id < b.fact_id ? [a, b] : [b, a];
  const key = lo.fact_id + "|" + hi.fact_id;
  if (!pairs.has(key)) pairs.set(key, { a: lo, b: hi, reason });
}

// (a) first-token equality + proper-prefix
const byFirstToken = new Map<string, Person[]>();
for (const p of people) {
  const t = firstToken(p.title);
  if (!t) continue;
  const arr = byFirstToken.get(t) ?? [];
  arr.push(p);
  byFirstToken.set(t, arr);
}
for (const [, group] of byFirstToken) {
  if (group.length < 2) continue;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      addPair(group[i], group[j], "first-token");
    }
  }
}

// Also: a single-token title (e.g. "Anil") vs any multi-token that starts with it
for (const p of people) {
  const pt = tokens(p.title);
  if (pt.length !== 1) continue;
  const first = pt[0].toLowerCase();
  for (const q of people) {
    if (q === p) continue;
    const qt = tokens(q.title);
    if (qt.length >= 2 && qt[0].toLowerCase() === first) {
      addPair(p, q, "single-name-prefix");
    }
  }
}

// (b) proper prefix (beyond the single-token case)
for (let i = 0; i < people.length; i++) {
  for (let j = i + 1; j < people.length; j++) {
    const a = people[i].title.toLowerCase().trim();
    const b = people[j].title.toLowerCase().trim();
    if (a === b) continue;
    if (a.length >= 3 && b.length >= 3 && (b.startsWith(a + " ") || a.startsWith(b + " "))) {
      addPair(people[i], people[j], "prefix");
    }
  }
}

// (c) trigram similarity via pg_trgm
const trigramMatches = await sql<Array<{ a_id: string; b_id: string; sim: number }>>`
  WITH people AS (
    SELECT fact_id, lower(btrim(title)) AS t
    FROM app.fact
    WHERE is_active = true AND is_factoid = true AND factoid_type = 'Person' AND title IS NOT NULL
  )
  SELECT p1.fact_id AS a_id, p2.fact_id AS b_id, similarity(p1.t, p2.t) AS sim
  FROM people p1
  JOIN people p2 ON p1.fact_id < p2.fact_id
  WHERE p1.t % p2.t
    AND similarity(p1.t, p2.t) >= ${TRIGRAM_THRESHOLD}
`;

const personById = new Map(people.map((p) => [p.fact_id, p]));
for (const m of trigramMatches) {
  const a = personById.get(m.a_id);
  const b = personById.get(m.b_id);
  if (a && b) addPair(a, b, `trigram(${m.sim.toFixed(2)})`);
}

const candidates = Array.from(pairs.values());
console.log(`[entity-linker] ${candidates.length} candidate pairs after pre-filter`);

// ============================================================================
// Haiku judge
// ============================================================================

interface Verdict {
  same: boolean;
  confidence: number;
  reason: string;
}

async function callHaiku(prompt: string): Promise<Verdict> {
  const apiKey = process.env.ANTHRO_API_KEY;
  if (!apiKey) throw new Error("ANTHRO_API_KEY not set");

  const RETRYABLE = new Set([429, 503, 529]);
  const MAX_ATTEMPTS = 5;
  let res!: Response;
  let lastBody = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (res.ok) break;
    lastBody = await res.text();
    if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS - 1) {
      throw new Error(`Haiku ${res.status}: ${lastBody}`);
    }
    const wait = Math.min(2_000 * 2 ** attempt, 30_000);
    console.log(`  [haiku ${res.status}] waiting ${wait}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) throw new Error(`Haiku ${res.status}: ${lastBody}`);

  const data = (await res.json()) as { content: { type: string; text: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/, "$1")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<Verdict>;
    return {
      same: parsed.same === true,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return { same: false, confidence: 0, reason: `parse failed: ${cleaned.slice(0, 120)}` };
  }
}

const SYSTEM_PROMPT = `You are a de-duplication judge for Vineel's personal memory graph.

You will be shown two Person factoids that might refer to the same real human. Decide whether they are the same person, using the name and the provided child facts as context.

Rules of thumb:
- A first-name-only factoid usually matches a full-name factoid with the same first name, IF the child facts are consistent or empty.
- A typo'd name (small edit distance, 1–3 characters) is usually the same person, especially if the child facts overlap.
- Two full names that differ in more than 2 characters are usually DIFFERENT people, even if the first name matches.
- If the child facts clearly describe different people (different affiliations, different roles at incompatible times, different family relationships), they are NOT the same, even if names match.
- When in doubt, say same=false.

Respond with JSON only, no prose:
{"same": true|false, "confidence": 0.0-1.0, "reason": "<one sentence>"}`;

function formatPerson(p: Person): string {
  const kids = p.kid_preview.length
    ? p.kid_preview.map((k) => `  - ${k}`).join("\n")
    : "  (no child facts)";
  return `Name: ${p.title}\nChild facts (${p.kid_count} total):\n${kids}`;
}

// ============================================================================
// Merge operation
// ============================================================================

/** Score how "canonical-name-like" a title is. A real person's canonical
 *  name is made of capitalized tokens only. Lowercase tokens (like "contact",
 *  "information", "at") and possessive fragments ("Umut's") are noise. */
function cleanlinessScore(title: string): number {
  const toks = tokens(title);
  let score = 0;
  for (const t of toks) {
    if (/['\u2019]/.test(t)) score -= 5;          // "Umut's" — heavy penalty, straight or curly
    else if (/^[A-Z]/.test(t)) score += 1;        // proper-cased token
    else if (/^[a-z]/.test(t)) score -= 1;        // lowercase noise word
  }
  return score;
}

function pickWinner(a: Person, b: Person): { winner: Person; loser: Person } {
  const aScore = cleanlinessScore(a.title);
  const bScore = cleanlinessScore(b.title);
  if (aScore !== bScore) return aScore > bScore ? { winner: a, loser: b } : { winner: b, loser: a };
  // Tie: prefer more tokens (more complete name), then more kids, then older.
  const at = tokens(a.title).length;
  const bt = tokens(b.title).length;
  if (at !== bt) return at > bt ? { winner: a, loser: b } : { winner: b, loser: a };
  if (a.kid_count !== b.kid_count)
    return a.kid_count > b.kid_count ? { winner: a, loser: b } : { winner: b, loser: a };
  return a.created_at < b.created_at ? { winner: a, loser: b } : { winner: b, loser: a };
}

async function mergeFactoids(winnerId: string, loserId: string): Promise<void> {
  // 1. Move child facts
  await sql`
    UPDATE app.fact
    SET parent_factoid_id = ${winnerId}, updated_at = now()
    WHERE parent_factoid_id = ${loserId}
  `;

  // 2. Move outgoing relationships (from = loser → from = winner)
  //    Delete any that would duplicate an existing (winner, to, type).
  await sql`
    DELETE FROM app.fact_relationship
    WHERE from_factoid_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM app.fact_relationship w
        WHERE w.from_factoid_id = ${winnerId}
          AND w.to_factoid_id = app.fact_relationship.to_factoid_id
          AND w.type = app.fact_relationship.type
      )
  `;
  await sql`
    UPDATE app.fact_relationship
    SET from_factoid_id = ${winnerId}
    WHERE from_factoid_id = ${loserId}
  `;

  // 3. Move incoming relationships (to = loser → to = winner)
  await sql`
    DELETE FROM app.fact_relationship
    WHERE to_factoid_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM app.fact_relationship w
        WHERE w.to_factoid_id = ${winnerId}
          AND w.from_factoid_id = app.fact_relationship.from_factoid_id
          AND w.type = app.fact_relationship.type
      )
  `;
  await sql`
    UPDATE app.fact_relationship
    SET to_factoid_id = ${winnerId}
    WHERE to_factoid_id = ${loserId}
  `;

  // 4. Repoint entity_address rows
  await sql`
    UPDATE app.entity_address
    SET factoid_id = ${winnerId}
    WHERE factoid_id = ${loserId}
  `;

  // 5. Deactivate the loser
  await sql`
    UPDATE app.fact
    SET is_active = false, updated_at = now()
    WHERE fact_id = ${loserId}
  `;
}

// ============================================================================
// Walk candidates, judge, and (optionally) merge
// ============================================================================

interface Decision {
  pair: Candidate;
  verdict: Verdict;
  applied: boolean;
  winner_id: string | null;
  loser_id: string | null;
}

const decisions: Decision[] = [];
const mergedLosers = new Set<string>();

let processed = 0;
for (const pair of candidates) {
  processed++;
  if (processed % 10 === 0) {
    console.log(`[entity-linker] ${processed}/${candidates.length}`);
  }

  // Skip pair if either side has already been merged away this run
  if (mergedLosers.has(pair.a.fact_id) || mergedLosers.has(pair.b.fact_id)) continue;

  const prompt = `Pair reason: ${pair.reason}

A:
${formatPerson(pair.a)}

B:
${formatPerson(pair.b)}

Are A and B the same real person? Respond with JSON only.`;

  let verdict: Verdict;
  try {
    verdict = await callHaiku(prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[entity-linker] FAIL ${pair.a.title} / ${pair.b.title} — ${msg.slice(0, 100)}`);
    continue;
  }

  let applied = false;
  let winnerId: string | null = null;
  let loserId: string | null = null;

  if (verdict.same && verdict.confidence >= MIN_CONFIDENCE) {
    const { winner, loser } = pickWinner(pair.a, pair.b);
    winnerId = winner.fact_id;
    loserId = loser.fact_id;
    if (APPLY) {
      try {
        await mergeFactoids(winner.fact_id, loser.fact_id);
        applied = true;
        mergedLosers.add(loser.fact_id);
        console.log(`[entity-linker] MERGED "${loser.title}" → "${winner.title}" (conf ${verdict.confidence.toFixed(2)})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[entity-linker] MERGE_FAIL ${loser.title} → ${winner.title} — ${msg.slice(0, 140)}`);
      }
    } else {
      console.log(`[entity-linker] WOULD MERGE "${loser.title}" → "${winner.title}" (conf ${verdict.confidence.toFixed(2)})`);
    }
  }

  decisions.push({ pair, verdict, applied, winner_id: winnerId, loser_id: loserId });
}

// ============================================================================
// Summary + audit
// ============================================================================

const wouldMergeCount = decisions.filter((d) => d.verdict.same && d.verdict.confidence >= MIN_CONFIDENCE).length;
const appliedCount = decisions.filter((d) => d.applied).length;
const skipped = decisions.filter((d) => !d.verdict.same || d.verdict.confidence < MIN_CONFIDENCE).length;

console.log("");
console.log(`=== Entity linker summary (${APPLY ? "APPLIED" : "DRY-RUN"}) ===`);
console.log(`Candidate pairs: ${candidates.length}`);
console.log(`Would merge:     ${wouldMergeCount}`);
console.log(`Applied merges:  ${appliedCount}`);
console.log(`Skipped:         ${skipped}`);

const AUDIT_DIR = `${import.meta.dir}/../../notes/farley-assessments`;
await mkdir(AUDIT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const auditPath = `${AUDIT_DIR}/entity-link-${stamp}${APPLY ? "" : "-dryrun"}.json`;
await Bun.write(
  auditPath,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      applied: APPLY,
      min_confidence: MIN_CONFIDENCE,
      candidate_count: candidates.length,
      would_merge: wouldMergeCount,
      applied_count: appliedCount,
      decisions: decisions.map((d) => ({
        a_id: d.pair.a.fact_id,
        a_title: d.pair.a.title,
        b_id: d.pair.b.fact_id,
        b_title: d.pair.b.title,
        reason: d.pair.reason,
        verdict: d.verdict,
        winner_id: d.winner_id,
        loser_id: d.loser_id,
        applied: d.applied,
      })),
    },
    null,
    2,
  ),
);
console.log(`Audit: ${auditPath}`);

await sql.end();
