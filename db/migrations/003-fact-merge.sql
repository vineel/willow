-- Factoid dedupe schema — supports the Phase 3 cleanup scripts.
-- See notes/person-dedupe-strategy.md §5 and Appendix B.
-- Additive only. Safe to run multiple times.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================================
-- 1. NORMALIZED_TITLE — application-maintained column for trigram blocking
-- ============================================================================
-- Full normalization pipeline (possessive stripping, suffix stripping,
-- attribution tail stripping) is awkward in pure SQL, so we store it as a
-- regular column and backfill / maintain it from the dedupe script.

ALTER TABLE app.fact
  ADD COLUMN IF NOT EXISTS normalized_title text;

CREATE INDEX IF NOT EXISTS idx_fact_normalized_title_trgm
  ON app.fact USING gin (normalized_title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_fact_normalized_title_exact
  ON app.fact (factoid_type, normalized_title)
  WHERE is_factoid = true AND is_active = true;

-- ============================================================================
-- 2. FACT_MERGE — audit record of applied (soft) merges
-- ============================================================================

CREATE TABLE IF NOT EXISTS app.fact_merge (
  merged_fact_id uuid PRIMARY KEY REFERENCES app.fact(fact_id),
  kept_fact_id   uuid NOT NULL REFERENCES app.fact(fact_id),
  reason         text NOT NULL,
  confidence     real NOT NULL,
  merged_at      timestamptz NOT NULL DEFAULT now(),
  merged_by      text NOT NULL,  -- 'auto', 'llm-judge', 'human'
  dry_run        boolean NOT NULL DEFAULT false,
  CHECK (merged_fact_id <> kept_fact_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_merge_kept ON app.fact_merge (kept_fact_id);

-- ============================================================================
-- 3. FACT_MERGE_CANDIDATE — proposed pairs with signals + LLM verdict
-- ============================================================================

CREATE TABLE IF NOT EXISTS app.fact_merge_candidate (
  candidate_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id_a      uuid NOT NULL REFERENCES app.fact(fact_id),
  fact_id_b      uuid NOT NULL REFERENCES app.fact(fact_id),
  blockers       text[] NOT NULL,
  signals        jsonb NOT NULL,
  classification text NOT NULL,  -- 'auto', 'review', 'rejected'
  llm_same       boolean,
  llm_confidence real,
  llm_reason     text,
  status         text NOT NULL DEFAULT 'pending',  -- 'pending', 'approved', 'rejected', 'applied'
  reviewed_by    text,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (fact_id_a < fact_id_b),  -- canonical ordering: dedupe pairs regardless of direction
  UNIQUE (fact_id_a, fact_id_b)
);

CREATE INDEX IF NOT EXISTS idx_fact_merge_candidate_status
  ON app.fact_merge_candidate (status, classification);

COMMIT;
