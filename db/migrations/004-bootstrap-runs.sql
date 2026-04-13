-- Bootstrap memory run tracking — supports --resume and post-run reports.
-- See notes/bootstrap-memory-plan.md.

BEGIN;

CREATE TABLE IF NOT EXISTS app.bootstrap_run (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  status            text NOT NULL DEFAULT 'running',
                    -- running, completed, failed, budget_exceeded, aborted
  args              jsonb NOT NULL,
  last_jmap_id      text,
  emails_fetched    int NOT NULL DEFAULT 0,
  emails_triaged    int NOT NULL DEFAULT 0,
  emails_survived   int NOT NULL DEFAULT 0,
  prefilter_calls   int NOT NULL DEFAULT 0,
  prefilter_yes     int NOT NULL DEFAULT 0,
  extraction_calls  int NOT NULL DEFAULT 0,
  facts_added       int NOT NULL DEFAULT 0,
  cost_prefilter    numeric(10, 4) NOT NULL DEFAULT 0,
  cost_extraction   numeric(10, 4) NOT NULL DEFAULT 0,
  error             text
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_run_status
  ON app.bootstrap_run (status, started_at DESC);

COMMIT;
