// Factoid dedupe — failure mode 2 from notes/person-dedupe-strategy.md.
//
// Pipeline:
//   1. Backfill app.fact.normalized_title via the shared normalizer.
//   2. Candidate pair generation via Blocks A-E.
//   3. Signal computation.
//   4. Rule-based classification (auto / review / rejected).
//   5. LLM judge on review-zone pairs (Haiku 4.5, prompt-cached).
//   6. Write all candidates to app.fact_merge_candidate.
//   7. On --apply, soft-merge auto + LLM-approved pairs.
//
// Requires migration 003-fact-merge.sql to be applied first.
//
//   bun run memory/scripts/dedupe-factoids.ts              # dry-run, calls LLM
//   bun run memory/scripts/dedupe-factoids.ts --apply      # write merges
//   bun run memory/scripts/dedupe-factoids.ts --no-llm     # skip LLM (debug)

import { sql } from "../db";
import { firstToken, normalizeTitle } from "../dedupe/normalize";
import { judgePair, type JudgeVerdict } from "../dedupe/llm-judge";

const APPLY = process.argv.includes("--apply");
const NO_LLM = process.argv.includes("--no-llm");

// ============================================================================
// 1. Load factoids and backfill normalized_title.
// ============================================================================

interface FactoidRow {
  fact_id: string;
  title: string | null;
  content: string;
  keywords: string[] | null;
  factoid_type: string | null;
  embedding: number[] | null;    // parsed from Postgres string form
  embeddingLiteral: string | null; // "[x,y,z,...]" for SQL passthrough
  human_verified: boolean;
  created_at: string;
  child_count: number;
  address_count: number;
  normalized: string;
  attributionTail: string | null;
}

function parseEmbedding(raw: unknown): { arr: number[] | null; lit: string | null } {
  if (raw == null) return { arr: null, lit: null };
  if (typeof raw === "string") {
    // Postgres pgvector returns "[1,2,3]" — already a vec literal.
    const arr = JSON.parse(raw) as number[];
    return { arr, lit: raw };
  }
  if (Array.isArray(raw)) {
    return { arr: raw as number[], lit: `[${(raw as number[]).join(",")}]` };
  }
  return { arr: null, lit: null };
}

console.log("Loading factoids...");

const rawRows = await sql<
  Array<{
    fact_id: string;
    title: string | null;
    content: string;
    keywords: string[] | null;
    factoid_type: string | null;
    embedding: unknown;
    human_verified: boolean;
    created_at: string;
  }>
>`
  SELECT fact_id, title, content, keywords, factoid_type, embedding,
         human_verified, created_at
  FROM app.fact
  WHERE is_active = true AND is_factoid = true AND factoid_type IS NOT NULL
  ORDER BY created_at ASC
`;

const factoids: FactoidRow[] = [];
const byId = new Map<string, FactoidRow>();
for (const r of rawRows) {
  const norm = normalizeTitle(r.title);
  const { arr, lit } = parseEmbedding(r.embedding);
  const row: FactoidRow = {
    fact_id: r.fact_id,
    title: r.title,
    content: r.content,
    keywords: r.keywords,
    factoid_type: r.factoid_type,
    embedding: arr,
    embeddingLiteral: lit,
    human_verified: r.human_verified,
    created_at: r.created_at,
    child_count: 0,
    address_count: 0,
    normalized: norm.normalized,
    attributionTail: norm.attributionTail,
  };
  factoids.push(row);
  byId.set(r.fact_id, row);
}
console.log(`  loaded ${factoids.length} factoids`);

// Child counts and address counts (separate queries, join in memory).
const childCounts = await sql<Array<{ parent_factoid_id: string; n: number }>>`
  SELECT parent_factoid_id, count(*)::int AS n
  FROM app.fact
  WHERE is_active = true AND parent_factoid_id IS NOT NULL
  GROUP BY parent_factoid_id
`;
for (const c of childCounts) {
  const f = byId.get(c.parent_factoid_id);
  if (f) f.child_count = c.n;
}

const addrCounts = await sql<Array<{ factoid_id: string; n: number }>>`
  SELECT factoid_id, count(*)::int AS n
  FROM app.entity_address
  GROUP BY factoid_id
`;
for (const a of addrCounts) {
  const f = byId.get(a.factoid_id);
  if (f) f.address_count = a.n;
}

// Backfill normalized_title column (used by Block B's trgm index).
console.log("Backfilling normalized_title...");
for (const f of factoids) {
  await sql`UPDATE app.fact SET normalized_title = ${f.normalized} WHERE fact_id = ${f.fact_id}`;
}

// Display names from entity_address for Block D.
const addrRows = await sql<
  Array<{ factoid_id: string; display_name: string | null }>
>`
  SELECT factoid_id, display_name FROM app.entity_address
  WHERE display_name IS NOT NULL AND display_name <> ''
`;
const displayNameByFactoid = new Map<string, Set<string>>();
for (const r of addrRows) {
  const norm = normalizeTitle(r.display_name).normalized;
  if (!norm) continue;
  let set = displayNameByFactoid.get(r.factoid_id);
  if (!set) {
    set = new Set();
    displayNameByFactoid.set(r.factoid_id, set);
  }
  set.add(norm);
}

// ============================================================================
// 2. Block pair generation.
// ============================================================================

type PairKey = string;
interface Pair {
  a: FactoidRow;
  b: FactoidRow;
  blockers: Set<string>;
}
const pairs = new Map<PairKey, Pair>();

function keyFor(a: string, b: string): PairKey {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function addPair(a: FactoidRow, b: FactoidRow, blocker: string) {
  if (a.fact_id === b.fact_id) return;
  if (a.factoid_type !== b.factoid_type) return;
  const [lo, hi] = a.fact_id < b.fact_id ? [a, b] : [b, a];
  const k = keyFor(a.fact_id, b.fact_id);
  let p = pairs.get(k);
  if (!p) {
    p = { a: lo, b: hi, blockers: new Set() };
    pairs.set(k, p);
  }
  p.blockers.add(blocker);
}

// Block A — normalized-name exact match (grouped per type).
console.log("Block A: normalized-title exact...");
{
  const groups = new Map<string, FactoidRow[]>();
  for (const f of factoids) {
    if (!f.normalized) continue;
    const k = `${f.factoid_type}::${f.normalized}`;
    let g = groups.get(k);
    if (!g) {
      g = [];
      groups.set(k, g);
    }
    g.push(f);
  }
  let blockACount = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        addPair(g[i], g[j], "A");
        blockACount++;
      }
    }
  }
  console.log(`  ${blockACount} pairs`);
}

// Block B — pg_trgm top-5 per factoid (same type, similarity >= 0.5).
console.log("Block B: trigram similarity...");
{
  let blockBCount = 0;
  for (const f of factoids) {
    if (!f.normalized || f.normalized.length < 4) continue;
    const neighbors = await sql<
      Array<{ fact_id: string; similarity: number }>
    >`
      SELECT fact_id, similarity(normalized_title, ${f.normalized}) AS similarity
      FROM app.fact
      WHERE is_active = true
        AND is_factoid = true
        AND factoid_type = ${f.factoid_type}
        AND fact_id <> ${f.fact_id}
        AND normalized_title % ${f.normalized}
      ORDER BY normalized_title <-> ${f.normalized}
      LIMIT 5
    `;
    for (const n of neighbors) {
      if (n.similarity < 0.5) continue;
      const other = byId.get(n.fact_id);
      if (other) {
        addPair(f, other, "B");
        blockBCount++;
      }
    }
  }
  console.log(`  ${blockBCount} pair-hits (dedup'd)`);
}

// Block C — pgvector cosine similarity, top-5 per factoid (same type).
console.log("Block C: embedding similarity...");
{
  let blockCCount = 0;
  for (const f of factoids) {
    if (!f.embeddingLiteral) continue;
    const lit = f.embeddingLiteral;
    const neighbors = await sql<
      Array<{ fact_id: string; score: number }>
    >`
      SELECT fact_id, 1 - (embedding <=> ${lit}::vector) AS score
      FROM app.fact
      WHERE is_active = true
        AND is_factoid = true
        AND factoid_type = ${f.factoid_type}
        AND fact_id <> ${f.fact_id}
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${lit}::vector
      LIMIT 5
    `;
    for (const n of neighbors) {
      if (n.score < 0.8) continue;
      const other = byId.get(n.fact_id);
      if (other) {
        addPair(f, other, "C");
        blockCCount++;
      }
    }
  }
  console.log(`  ${blockCCount} pair-hits (dedup'd)`);
}

// Block D — entity_address display_name match.
console.log("Block D: shared display_name...");
{
  const byDisplayName = new Map<string, Set<string>>();
  for (const [factoidId, names] of displayNameByFactoid) {
    for (const n of names) {
      let set = byDisplayName.get(n);
      if (!set) {
        set = new Set();
        byDisplayName.set(n, set);
      }
      set.add(factoidId);
    }
  }
  let blockDCount = 0;
  for (const ids of byDisplayName.values()) {
    if (ids.size < 2) continue;
    const arr = [...ids].map((id) => byId.get(id)).filter((x): x is FactoidRow => !!x);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        addPair(arr[i], arr[j], "D");
        blockDCount++;
      }
    }
  }
  console.log(`  ${blockDCount} pairs`);
}

// Block E — attribution tail is added as a signal, not a new pair source.
// It's read at scoring time below.

console.log(`Total unique candidate pairs: ${pairs.size}`);

// ============================================================================
// 3. Signal computation + 4. classification.
// ============================================================================

interface Signals {
  type_match: boolean;
  norm_title_equal: boolean;
  trigram_score: number;
  embedding_score: number;
  first_token_equal: boolean;
  attribution_tail_equal: boolean;
  shares_address_display_name: boolean;
  content_len_min: number;
  human_verified_a: boolean;
  human_verified_b: boolean;
  has_child_facts_a: number;
  has_child_facts_b: number;
}

type Classification = "auto" | "review" | "rejected";

function trigramSim(a: string, b: string): number {
  if (!a || !b) return 0;
  const ngrams = (s: string): Set<string> => {
    const padded = `  ${s}  `;
    const set = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const A = ngrams(a);
  const B = ngrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function computeSignals(p: Pair): Signals {
  const a = p.a;
  const b = p.b;
  const tail_a = a.attributionTail ?? "";
  const tail_b = b.attributionTail ?? "";
  const dnA = displayNameByFactoid.get(a.fact_id) ?? new Set<string>();
  const dnB = displayNameByFactoid.get(b.fact_id) ?? new Set<string>();
  let shares_display = false;
  for (const x of dnA) if (dnB.has(x)) { shares_display = true; break; }

  return {
    type_match: a.factoid_type === b.factoid_type,
    norm_title_equal: a.normalized === b.normalized && a.normalized !== "",
    trigram_score: trigramSim(a.normalized, b.normalized),
    embedding_score:
      a.embedding && b.embedding ? cosine(a.embedding, b.embedding) : 0,
    first_token_equal:
      firstToken(a.normalized) !== "" &&
      firstToken(a.normalized) === firstToken(b.normalized),
    attribution_tail_equal:
      tail_a !== "" && tail_b !== "" && tail_a === tail_b,
    shares_address_display_name: shares_display,
    content_len_min: Math.min(a.content.length, b.content.length),
    human_verified_a: a.human_verified,
    human_verified_b: b.human_verified,
    has_child_facts_a: a.child_count,
    has_child_facts_b: b.child_count,
  };
}

function classify(s: Signals): Classification {
  if (!s.type_match) return "rejected";

  // Namesake guard: first token equal but not full norm match AND embedding
  // is only weakly similar → park in review (could be two different people
  // with the same first name).
  const namesakeCollision =
    s.first_token_equal && !s.norm_title_equal && s.embedding_score < 0.75;

  if (!namesakeCollision) {
    if (
      s.norm_title_equal &&
      (s.content_len_min > 20 ||
        s.shares_address_display_name ||
        s.embedding_score > 0.8)
    ) {
      return "auto";
    }
    if (s.trigram_score > 0.92 && s.embedding_score > 0.8) return "auto";
    if (s.shares_address_display_name && s.embedding_score > 0.75) return "auto";
    if (
      s.norm_title_equal &&
      s.has_child_facts_a > 0 &&
      s.has_child_facts_b === 0
    ) {
      return "auto";
    }
    if (
      s.norm_title_equal &&
      s.has_child_facts_b > 0 &&
      s.has_child_facts_a === 0
    ) {
      return "auto";
    }
  }

  // Review zone.
  if (s.trigram_score > 0.7 && s.trigram_score <= 0.92) return "review";
  if (s.embedding_score > 0.75 && s.embedding_score <= 0.9) return "review";
  if (s.first_token_equal && s.embedding_score > 0.75) return "review";
  if (s.norm_title_equal && s.content_len_min < 20) return "review";

  return "rejected";
}

// ============================================================================
// 5. LLM judge for review zone.
// ============================================================================

interface ScoredPair {
  pair: Pair;
  signals: Signals;
  classification: Classification;
  verdict: JudgeVerdict | null;
}

const scored: ScoredPair[] = [];
for (const p of pairs.values()) {
  const signals = computeSignals(p);
  const classification = classify(signals);
  scored.push({ pair: p, signals, classification, verdict: null });
}

const counts = { auto: 0, review: 0, rejected: 0 };
for (const s of scored) counts[s.classification]++;
console.log("");
console.log(
  `Classified: auto=${counts.auto}  review=${counts.review}  rejected=${counts.rejected}`,
);

if (!NO_LLM && counts.review > 0) {
  console.log(`Calling Haiku judge on ${counts.review} review-zone pairs...`);
  let done = 0;
  for (const s of scored) {
    if (s.classification !== "review") continue;
    try {
      s.verdict = await judgePair({
        titleA: s.pair.a.title ?? "",
        typeA: s.pair.a.factoid_type,
        contentA: s.pair.a.content,
        keywordsA: s.pair.a.keywords ?? [],
        titleB: s.pair.b.title ?? "",
        typeB: s.pair.b.factoid_type,
        contentB: s.pair.b.content,
        keywordsB: s.pair.b.keywords ?? [],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      s.verdict = { same: null, confidence: 0, reason: `error: ${msg}` };
    }
    done++;
    if (done % 10 === 0) console.log(`  judged ${done}/${counts.review}`);
  }
}

// ============================================================================
// 6. Write candidates + print summary.
// ============================================================================

console.log("");
console.log("Writing candidates to app.fact_merge_candidate...");
await sql`
  TRUNCATE app.fact_merge_candidate
`;
for (const s of scored) {
  if (s.classification === "rejected") continue;
  await sql`
    INSERT INTO app.fact_merge_candidate
      (fact_id_a, fact_id_b, blockers, signals, classification,
       llm_same, llm_confidence, llm_reason)
    VALUES (
      ${s.pair.a.fact_id},
      ${s.pair.b.fact_id},
      ${[...s.pair.blockers]},
      ${sql.json(s.signals as unknown as Record<string, unknown>)},
      ${s.classification},
      ${s.verdict?.same ?? null},
      ${s.verdict?.confidence ?? null},
      ${s.verdict?.reason ?? null}
    )
    ON CONFLICT (fact_id_a, fact_id_b) DO UPDATE SET
      blockers = EXCLUDED.blockers,
      signals = EXCLUDED.signals,
      classification = EXCLUDED.classification,
      llm_same = EXCLUDED.llm_same,
      llm_confidence = EXCLUDED.llm_confidence,
      llm_reason = EXCLUDED.llm_reason
  `;
}

console.log("");
console.log("AUTO-MERGE pairs:");
for (const s of scored) {
  if (s.classification !== "auto") continue;
  console.log(
    `  ${s.pair.a.title}  ≡  ${s.pair.b.title}  [${[...s.pair.blockers].join(",")}]`,
  );
}
console.log("");
console.log("REVIEW pairs (LLM verdict):");
for (const s of scored) {
  if (s.classification !== "review") continue;
  const v = s.verdict;
  const verdictStr = v
    ? `${v.same === true ? "YES" : v.same === false ? "NO" : "?"} (${v.confidence.toFixed(2)})`
    : "(no llm)";
  console.log(
    `  ${verdictStr}  ${s.pair.a.title}  ≡  ${s.pair.b.title}  — ${v?.reason ?? ""}`,
  );
}

// ============================================================================
// 7. Apply soft merges.
// ============================================================================

function pickWinner(a: FactoidRow, b: FactoidRow): [FactoidRow, FactoidRow] {
  // Returns [winner, loser].
  const compare = (): number => {
    if (a.human_verified !== b.human_verified) return a.human_verified ? 1 : -1;
    if (a.child_count !== b.child_count) return a.child_count - b.child_count;
    if (a.content.length !== b.content.length) return a.content.length - b.content.length;
    if (a.address_count !== b.address_count) return a.address_count - b.address_count;
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return tb - ta; // older wins → higher score for older
  };
  return compare() >= 0 ? [a, b] : [b, a];
}

const toMerge: Array<{ winner: FactoidRow; loser: FactoidRow; reason: string; confidence: number; mergedBy: "auto" | "llm-judge" }> = [];
for (const s of scored) {
  if (s.classification === "auto") {
    const [winner, loser] = pickWinner(s.pair.a, s.pair.b);
    toMerge.push({
      winner,
      loser,
      reason: `auto: blockers=${[...s.pair.blockers].join(",")}`,
      confidence: 0.95,
      mergedBy: "auto",
    });
  } else if (
    s.classification === "review" &&
    s.verdict?.same === true &&
    s.verdict.confidence >= 0.75
  ) {
    const [winner, loser] = pickWinner(s.pair.a, s.pair.b);
    toMerge.push({
      winner,
      loser,
      reason: `llm-judge: ${s.verdict.reason}`,
      confidence: s.verdict.confidence,
      mergedBy: "llm-judge",
    });
  }
}

console.log("");
console.log(`Proposed merges: ${toMerge.length}`);

if (!APPLY) {
  console.log("Dry-run only. Re-run with --apply to write merges.");
  await sql.end();
  process.exit(0);
}

// Transitive merges: if winner of one pair is itself the loser of another,
// walk forward. Use a union-find by loser→winner pointer.
const redirect = new Map<string, string>();
function resolve(id: string): string {
  let cur = id;
  while (redirect.has(cur)) cur = redirect.get(cur)!;
  return cur;
}

let applied = 0;
for (const m of toMerge) {
  const winnerId = resolve(m.winner.fact_id);
  const loserId = resolve(m.loser.fact_id);
  if (winnerId === loserId) continue; // already merged via another chain

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO app.fact_merge
        (merged_fact_id, kept_fact_id, reason, confidence, merged_by, dry_run)
      VALUES (${loserId}, ${winnerId}, ${m.reason}, ${m.confidence}, ${m.mergedBy}, false)
      ON CONFLICT (merged_fact_id) DO NOTHING
    `;
    await tx`UPDATE app.fact SET is_active = false, parent_factoid_id = ${winnerId} WHERE fact_id = ${loserId}`;
    await tx`UPDATE app.fact SET parent_factoid_id = ${winnerId} WHERE parent_factoid_id = ${loserId}`;
    await tx`UPDATE app.entity_address SET factoid_id = ${winnerId} WHERE factoid_id = ${loserId}`;
    await tx`UPDATE app.source_note SET from_factoid_id = ${winnerId} WHERE from_factoid_id = ${loserId}`;
    await tx`UPDATE app.fact_relationship SET from_factoid_id = ${winnerId} WHERE from_factoid_id = ${loserId}`;
    await tx`UPDATE app.fact_relationship SET to_factoid_id = ${winnerId} WHERE to_factoid_id = ${loserId}`;
    await tx`DELETE FROM app.fact_relationship WHERE from_factoid_id = to_factoid_id`;
    await tx`
      WITH merged_recency AS (
        SELECT ${winnerId}::uuid AS factoid_id,
               max(last_mentioned) AS last_mentioned,
               sum(mention_count)::int AS mention_count,
               max(weight) AS weight,
               max(window_expires) AS window_expires
        FROM app.recency_context
        WHERE factoid_id IN (${winnerId}, ${loserId})
      )
      INSERT INTO app.recency_context (factoid_id, last_mentioned, mention_count, weight, window_expires)
      SELECT * FROM merged_recency WHERE last_mentioned IS NOT NULL
      ON CONFLICT (factoid_id) DO UPDATE SET
        last_mentioned = EXCLUDED.last_mentioned,
        mention_count = EXCLUDED.mention_count,
        weight = EXCLUDED.weight,
        window_expires = EXCLUDED.window_expires
    `;
    await tx`DELETE FROM app.recency_context WHERE factoid_id = ${loserId}`;
    await tx`UPDATE app.fact_merge_candidate SET status = 'applied' WHERE fact_id_a = ${m.loser.fact_id} OR fact_id_b = ${m.loser.fact_id}`;
  });

  redirect.set(loserId, winnerId);
  applied++;
}

console.log(`Applied ${applied} merges.`);
await sql.end();
