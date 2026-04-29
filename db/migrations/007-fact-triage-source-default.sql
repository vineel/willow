-- Allow 'default' as a valid triage_source on app.fact.
--
-- The triage engine (pib/triage/engine.ts) returns
-- { action: 'queue', source: 'default' } when an event matches no rule, but
-- the original CHECK constraint only allowed { 'header','rule','llm','manual' }.
-- That mismatch silently dropped 149 emails between 2026-04-10 and 2026-04-29
-- (insert raised an error, pipeline caught it, no fact row was created).
--
-- 'default' is a meaningful source — it tells the digest/UI that no rule
-- matched and the action came from the engine fallback — so we keep it
-- distinct rather than collapsing onto an existing value.

ALTER TABLE app.fact DROP CONSTRAINT fact_triage_source_check;

ALTER TABLE app.fact ADD CONSTRAINT fact_triage_source_check
  CHECK (triage_source = ANY (ARRAY['header','rule','llm','manual','default']));
