# Factoid Dedupe Strategy

**Status:** Design, not yet implemented
**Date:** 2026-04-13
**Scope:** Covers all factoid types, but Person is the primary driver. Informs the one-time cleanup sweep and the ongoing maintenance process.

## Goal

Willow's Second Brain should carry **one factoid per real-world entity**, with all facts about that entity hanging off it as children. The farley-file goal (per-person dossiers) depends entirely on this invariant. It is currently broken — see the Audit section below.

## Audit: why the current state is broken

As of 2026-04-13, `app.fact WHERE is_factoid=true AND factoid_type='Person'` has **263 rows** but ~40–50 real humans. The junk comes from three distinct failure modes:

### Failure mode 1 — Bleed from other types

`Netflix Login`, `tmux window management`, `Why Amazon?`, `Prudential Center`, `NVIDIA` all tagged as Person. Two root causes, already fixed in Phase 1:

- `pib/entity-resolver.ts` defaulted every unknown email sender to `Person`. Fixed: now defaults to `Unknown`.
- `memory/extractor/prompts.ts` had a strong PEOPLE rule and no negative rules. Fixed: rewritten with explicit "not a factoid" section and `Account` / `Unknown` types.

Cleanup handling: **reclassification sweep**, not dedupe. See `cleanup-factoid-types.md` (to be written with the cleanup script).

### Failure mode 2 — Duplication within Person

Real people duplicated N times. Examples:

- `Michael Spencer from AI Supremacy` ×7 — different Substack/Beehiiv send addresses each minted a fresh factoid, because `entity_address` is keyed by address and newsletter platforms rotate per-send.
- `Scott Galloway` ×3, `Peter Yang` ×3, `NVIDIA` ×5, `Prudential Center` ×7 — same mechanism for organizations before Phase 1 fix.
- `Thushara Paul` / `Dushara Paul` / `Thurshara's role and team structure` — same person, different title spellings (including typos).
- `Brad` (notes) vs `Brad Simon <...>` (PIB) — same person, different pipelines, different title structures.

Cleanup handling: **dedupe run** — the subject of this document.

### Failure mode 3 — Fragmented dossier (missing parent)

Multiple child facts exist but no parent factoid to hang them off:

- `Neela's ulcer`, `Neela's Medicine Schedule`, `Neela's bed`, `Neela's health concerns and stress test`, `Neela's Updated Medicine Schedule` — five facts about Vineel's mother, no factoid for "Neela Shah" itself.
- Similar pattern for `Vineel's ...` (11+ fragments), `Zeph's ...`, `Brad's ...`.

These are NOT duplicates of each other — they are orphaned children. Detection pattern: 3+ active facts sharing a normalized possessive prefix (`X's ...`) where no factoid named `X` exists. Resolution: create the parent factoid (or find it via name match), then set `parent_factoid_id` on the children.

Cleanup handling: **parent-reparent sweep**, distinct from dedupe. Covered here in §6 because it uses the same signal stack.

---

## 1. Candidate pair generation

Goal: produce all pairs that *might* be duplicates, high recall. Operate per `factoid_type` — never cross types.

Five "blockers" (in the record-linkage sense — cheap filters that generate candidate pairs before expensive scoring):

### Block A — Normalized-name exact match

Normalization pipeline for titles:

1. Lowercase
2. Strip punctuation except inner letters (keep hyphens in names)
3. Strip possessive `'s` and trailing `'`
4. Strip common suffixes: ` contact`, ` contacts`, ` account`, ` login`, ` info`, ` details`, ` background`, ` role`, ` role and team structure`, ` interview preparation`, ` via messenger`, ` via facebook`, ` on facebook`, ` on linkedin`
5. Strip parenthetical tails: `(AKA ...)`, `(old ...)`
6. Strip newsletter/publication attribution tails: ` from X`, ` via X`, ` at X` — but **remember** the stripped `X` on the side (it's a signal, see Block E)
7. Collapse whitespace

Group by normalized name, any group of size ≥ 2 emits all intra-group pairs.

**Strengths:** Catches `Peter Yang`×3, `Scott Galloway`×3, `NVIDIA`×5 trivially. Free.
**Misses:** Typos in the root name (`Thushara` vs `Dushara`).
**Expected precision:** >98% for auto-merge when content signals agree.

### Block B — Trigram similarity (pg_trgm)

`CREATE EXTENSION IF NOT EXISTS pg_trgm` (likely already installed; verify).

Add a GIN trgm index on a generated normalized-title column. For each factoid, find top-5 neighbors of the same type with `similarity(normalized_title_a, normalized_title_b) >= 0.5`.

**Strengths:** Catches typos (`Thushara` vs `Thurshara`, similarity ~0.65). Catches suffix variants that survive Block A.
**Misses:** Short titles (<6 chars) are unreliable in trigram space. Cross-pipeline structural mismatch (`Brad` vs `Brad Simon`, similarity 0.4 — below threshold).
**Cost:** O(N·log N) with index; trivial at current 600-factoid scale.

### Block C — Embedding cosine similarity (pgvector)

Every fact already has a 768-dim `embedding`. Use it.

For each factoid, find top-5 neighbors of the same type with `1 - (embedding <=> other.embedding) >= 0.80` (cosine).

**Strengths:** Catches semantic equivalence the string match misses. `Brad Simon's Background and Role` and `Brad's Idea for Conflict Resolution` probably cosine ~0.82 even with very different titles — the content embedding carries the "Brad Simon at Accordli" context.
**Misses:** Very short or empty content on one side (embedding becomes noise). Different real people with similar bios (namesake collision).
**Cost:** pgvector index handles it.

### Block D — Entity-address graph

PIB creates one `entity_address` row per (source_type, address) pair. For every factoid with at least one `entity_address` row, look at the `display_name` column. Normalize it with the same pipeline as titles. If two factoids have any address whose normalized display_name matches → emit a candidate pair.

**Strengths:** Catches the Substack/Beehiiv rotation problem. If `michael@supremacy-newsletter-01.com` and `michael@supremacy-newsletter-02.com` both have display_name `"Michael Spencer from AI Supremacy"`, they're obviously the same sender.
**Misses:** Senders whose display_name genuinely varies between sends.
**Cost:** Single join, indexed.

### Block E — "X from Y" attribution pattern

At extraction time, Block A strips ` from Y` suffixes. During dedupe, remember the stripped Y as a hint. For two factoids normalized to the same X, if the stripped Y values also normalize the same → very high confidence. If X matches but Y differs → lower confidence (could be two different Michael Spencers writing for different newsletters).

This is also a **pre-signal for splitting**: `Michael Spencer from AI Supremacy` should probably become two factoids (Person "Michael Spencer" + Organization "AI Supremacy" + relationship). Handle splitting in a separate pass after merging.

### Pair deduplication

Union the outputs of A/B/C/D/E, dedupe the unordered pairs, produce `(fact_id_a, fact_id_b, blocker_sources[])`.

## 2. Signal computation

For each candidate pair, compute:

| Signal | Type | Notes |
|---|---|---|
| `type_match` | bool | Must be true to proceed. Different types → handle via reclassification, not merge. |
| `norm_title_equal` | bool | After normalization pipeline. |
| `trigram_score` | 0..1 | On normalized titles. |
| `embedding_score` | 0..1 | Cosine on existing `embedding` column. |
| `first_token_equal` | bool | After normalization. |
| `attribution_tail_equal` | bool | The "Y" from `X from Y` pattern, if present on both. |
| `shares_address` | bool | Via `entity_address`. |
| `shares_address_display_name` | bool | Via `entity_address`. |
| `content_len_min` | int | min(len(content_a), len(content_b)) — short content reduces signal reliability. |
| `human_verified_a/b` | bool | From `fact.human_verified`. |
| `has_child_facts_a/b` | int | count of `parent_factoid_id` children. |

Cost is free — all from columns already in the DB.

## 3. Classification (pre-LLM rules)

Each pair lands in one of three buckets.

### Auto-merge

All of:
- `type_match = true`
- NOT (namesake collision — first_token_equal but norm_title not equal and surnames clearly differ)
- Any of:
  - `norm_title_equal AND (content_len_min > 20 OR shares_address OR embedding_score > 0.80)`
  - `trigram_score > 0.92 AND embedding_score > 0.80`
  - `shares_address_display_name AND embedding_score > 0.75`
  - `norm_title_equal AND has_child_facts_a > 0 AND has_child_facts_b == 0` — merging the new one into the established one is safe

### Manual / LLM review

Any of, none of auto:
- `0.70 < trigram_score ≤ 0.92`
- `0.75 < embedding_score ≤ 0.90`
- `first_token_equal AND embedding_score > 0.75` (possible namesake)
- `norm_title_equal AND content_len_min < 20` (both too thin to auto-trust)

### Reject

Everything else — not a duplicate candidate.

## 4. LLM judge (for review zone)

Send review-zone pairs to Claude Haiku 4.5. Prompt shape:

```
Two factoids were found in Vineel's personal memory. Are they the same real-world entity?

Factoid A: {title_a}
  type: {type_a}
  content: {content_a}
  keywords: {keywords_a}

Factoid B: {title_b}
  type: {type_b}
  content: {content_b}
  keywords: {keywords_b}

Respond with JSON only:
{"same": true|false|null, "confidence": 0-1, "reason": "<one sentence>"}

Use null for "same" if you genuinely cannot tell from the information given.
```

System prompt is static → prompt caching amortizes heavily. Budget: ~$0.0001/pair × 1000 pairs = $0.10.

LLM verdict → per-pair record in `app.fact_merge_candidate` with `llm_same`, `llm_confidence`, `llm_reason`. Does NOT auto-apply — user reviews the list before anything is written.

## 5. Merge application (soft merge)

```sql
CREATE TABLE app.fact_merge (
  merged_fact_id uuid PRIMARY KEY REFERENCES app.fact(fact_id),
  kept_fact_id   uuid NOT NULL REFERENCES app.fact(fact_id),
  reason         text NOT NULL,       -- "normalized name", "trigram 0.94", "llm yes", "manual"
  confidence     real NOT NULL,
  merged_at      timestamp with time zone NOT NULL DEFAULT now(),
  merged_by      text NOT NULL,       -- "auto", "llm-judge", "human"
  dry_run        boolean NOT NULL DEFAULT false
);
```

**Winner selection rule** (for each merge pair):

1. `human_verified=true` beats non-verified
2. More child facts wins
3. Longer content wins
4. More `entity_address` rows wins
5. Older `created_at` wins (stable ids)

**Application steps** (transaction per merge):

1. Insert `app.fact_merge` row
2. `UPDATE app.fact SET is_active=false, parent_factoid_id=$kept WHERE fact_id=$merged`
3. `UPDATE app.fact SET parent_factoid_id=$kept WHERE parent_factoid_id=$merged` (rehome the loser's children)
4. `UPDATE app.entity_address SET factoid_id=$kept WHERE factoid_id=$merged`
5. `UPDATE app.source_note SET from_factoid_id=$kept WHERE from_factoid_id=$merged`
6. `UPDATE app.fact_relationship SET subject_fact_id=$kept WHERE subject_fact_id=$merged`
7. Same for `object_fact_id`
8. Collapse `app.recency_context`: sum `mention_count`, max `last_mentioned`, drop the merged row

Dedupe any relationships that become self-loops after rewiring.

**Reversibility:** to unmerge, reverse steps 2–8 using the `app.fact_merge` row as the audit record. Possible but tedious. Policy: prefer conservative auto-merge rules so unmerge is rarely needed.

## 6. Fragmented-dossier handling (parent reparent)

Separate pass, same signal stack.

Detection:
```sql
SELECT regexp_replace(title, '^(\w+)''?s\s.*', '\1') AS prefix, count(*)
FROM app.fact
WHERE is_active AND title ~ '^\w+''?s\s'
GROUP BY prefix HAVING count(*) >= 3;
```

For each prefix with 3+ hits: search `app.fact WHERE is_factoid AND factoid_type='Person' AND normalized_title LIKE prefix%`. If a factoid exists → set `parent_factoid_id` on the fragments to point at it. If none exists → create one (`Unknown` type unless we can infer from context), set as parent.

Do not merge the fragments into the parent — they stay as distinct child facts, just properly rooted.

## 7. On-insert dedupe (once cleanup is done)

Both writer paths must consult dedupe before creating a new factoid:

- `pib/entity-resolver.ts::resolveAddress` — before inserting a new factoid for an unknown address, do a Block A + D check. If a matching factoid exists with a compatible display_name, link the new address to the existing factoid instead of creating a new one.
- `memory/extractor/extract.ts::saveExtraction` — before inserting any fact with `is_factoid=true`, run Block A + B + C. If auto-merge territory, replace with a reference to the existing factoid.

This prevents the duplication mess from rebuilding after cleanup.

## 8. Maintenance process

Once the one-time cleanup lands:

- **Daily** (via `pib/worker.ts` cron): run Blocks A/D on factoids created in the last 24h. Auto-merge obvious ones.
- **Weekly**: run the full signal stack on everything created that week. Route review-zone pairs through Haiku judge. Email the resulting list via the digest for human approval. Apply approved merges on response.
- **Monthly**: full re-scan to catch cross-pipeline duplicates that snuck in.

The maintenance process lives in a new task type registered with Graphile Worker. Merges from it are always `dry_run=false, merged_by='auto'` or `'llm-judge'` — human-approved merges are `'human'`.

## 9. Open questions

1. **Namesake collision detection.** How do we distinguish two real different people named "Michael Spencer"? Current plan: require content-signal concordance (embedding > 0.80) AND at least one of (shared_address, attribution_tail_match). If only name matches, park in review zone. Revisit after seeing false positives in the first cleanup run.
2. **Normalization pipeline correctness.** Suffix stripping is heuristic. Worth logging the "before/after normalization" for the first run and eyeballing 30 random examples.
3. **Cross-type collisions.** Two factoids with same normalized name but different `factoid_type` (e.g. `Spotify` as Organization AND `Spotify` as Person from a legacy row). Should these auto-merge into the non-Person one, or route to reclassification first? Current plan: reclassification sweep runs before dedupe, so by the time dedupe runs these should be same-type.
4. **Embedding staleness.** If a factoid's content has changed since its embedding was computed, the embedding is wrong. Need to check: does the processor re-embed on content update? If not, add a `needs_reembed` flag before running dedupe.
5. **Merge confidence decay.** Old merges done at low-confidence may be wrong. Track `confidence` on every merge so we can re-audit the low-confidence ones later.

## 10. What we'll learn from the first run

After executing Phase 3 (one-time cleanup), write `notes/factoid-cleanup-retro.md` capturing:

- How many pairs each block generated, how much overlap between blocks
- Auto-merge count and inspection of random sample for false positives
- Review-zone count, LLM verdict distribution, human agreement rate with LLM
- False negatives discovered by eyeball (pairs that should have merged but didn't)
- Threshold adjustments needed
- Parent-reparent sweep results

This retro feeds directly into the maintenance job config. The goal is to turn the one-time sweep into a recurring worker with calibrated thresholds.

## Appendix A — Why not simpler

- **Why not just normalize + exact match and call it done?** It handles ~40% of the junk but misses typos, cross-pipeline pairs, and namesake-rich cases. Not good enough for the farley file.
- **Why not just embedding similarity?** Too many false positives on thin content, and namesake collisions embed similarly. String signals are necessary.
- **Why not just LLM judge everything?** Expensive at scale, and the LLM has no way to know Willow's ground truth — it'll confidently merge wrong pairs when both descriptions are plausible. LLM is a tiebreaker, not a judge.
- **Why soft merge instead of hard merge?** First-run confidence is low. Soft merges are a debuggable audit trail. Convert to hard merge after 2–3 cycles of confirmed correctness.

## Appendix B — Data model changes needed

```sql
-- New table
CREATE TABLE app.fact_merge (...);  -- see §5

-- New table (optional — could also live in fact_merge with pending status)
CREATE TABLE app.fact_merge_candidate (
  candidate_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id_a      uuid NOT NULL REFERENCES app.fact(fact_id),
  fact_id_b      uuid NOT NULL REFERENCES app.fact(fact_id),
  blockers       text[] NOT NULL,
  signals        jsonb NOT NULL,
  classification text NOT NULL,  -- 'auto', 'review', 'rejected'
  llm_same       boolean,
  llm_confidence real,
  llm_reason     text,
  status         text NOT NULL DEFAULT 'pending',  -- 'pending', 'approved', 'rejected'
  reviewed_by    text,
  reviewed_at    timestamp with time zone,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (fact_id_a, fact_id_b)
);

-- New generated column on fact (for trgm index)
ALTER TABLE app.fact
  ADD COLUMN normalized_title text
  GENERATED ALWAYS AS (lower(regexp_replace(title, '...', '', 'g'))) STORED;

CREATE INDEX idx_fact_normalized_title_trgm
  ON app.fact USING gin (normalized_title gin_trgm_ops);
```

(The `normalized_title` generated expression needs the full normalization pipeline — may be easier to do in the application layer and store as a regular column updated via trigger or backfill.)

## Appendix C — Files to create for Phase 3

- `scripts/cleanup-factoid-types.ts` — reclassification sweep (Failure mode 1)
- `scripts/dedupe-factoids.ts` — dedupe run (Failure mode 2)
- `scripts/reparent-fragments.ts` — parent-reparent pass (Failure mode 3)
- `db/migrations/002-fact-merge.sql` — schema changes from Appendix B
- `notes/factoid-cleanup-retro.md` — written after the first run

Each script supports `--dry-run` (default) and `--apply`. Dry-run prints proposed changes; apply writes them inside a transaction.
