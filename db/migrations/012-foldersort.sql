-- Foldersort: deterministic + LLM-driven sorting of inbox mail into
-- subfolders of willow-secondary. Proposal-only in v0; no JMAP moves are
-- triggered by the pipeline.
--
-- Adds three new tables and six columns on app.fact.
-- Idempotent: safe to re-run.

BEGIN;

-- ============================================================================
-- FOLDER_PROFILE — catalog entry per willow-secondary subfolder
-- ============================================================================

CREATE TABLE IF NOT EXISTS app.folder_profile (
  name              text PRIMARY KEY,                       -- subfolder leaf name
  mailbox_id        text,                                   -- JMAP mailbox id (refreshed on bootstrap)
  parent_path       text DEFAULT 'willow-secondary',
  description       text NOT NULL DEFAULT '',               -- one-line shown to LLM
  llm_hint          text,                                   -- longer guidance, optional
  example_subjects  text[] NOT NULL DEFAULT '{}',
  example_senders   text[] NOT NULL DEFAULT '{}',
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folder_profile_enabled
  ON app.folder_profile (enabled);

-- ============================================================================
-- FOLDER_RULE — deterministic shortcut (parallel to triage_rule)
-- ============================================================================

CREATE TABLE IF NOT EXISTS app.folder_rule (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  field           text NOT NULL,                            -- 'from_address','from_domain','subject','header','source_type'
  operator        text NOT NULL CHECK (operator IN ('equals','contains','starts_with','ends_with','regex','exists','gte')),
  value           text,
  header_name     text,
  target_folder   text NOT NULL REFERENCES app.folder_profile(name) ON DELETE RESTRICT,
  priority        integer NOT NULL DEFAULT 100,
  enabled         boolean NOT NULL DEFAULT true,
  confirmed       boolean NOT NULL DEFAULT false,
  source          text NOT NULL CHECK (source IN ('system','user','agent')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folder_rule_active
  ON app.folder_rule (priority) WHERE enabled = true AND confirmed = true;
CREATE INDEX IF NOT EXISTS idx_folder_rule_target
  ON app.folder_rule (target_folder);

-- ============================================================================
-- CORRESPONDENT — addresses Vineel has emailed; the "people I know" list
-- ============================================================================

CREATE TABLE IF NOT EXISTS app.correspondent (
  address       text PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('scan','manual')),
  note          text,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_correspondent_source
  ON app.correspondent (source);

-- ============================================================================
-- FACT — foldersort decision columns (mirror triage_action/source/rule_id)
-- ============================================================================

ALTER TABLE app.fact ADD COLUMN IF NOT EXISTS folder_target text;
ALTER TABLE app.fact ADD COLUMN IF NOT EXISTS folder_decided_by text;
ALTER TABLE app.fact ADD COLUMN IF NOT EXISTS folder_rule_id uuid;
ALTER TABLE app.fact ADD COLUMN IF NOT EXISTS folder_reason text;
ALTER TABLE app.fact ADD COLUMN IF NOT EXISTS folder_proposed_at timestamptz;
ALTER TABLE app.fact ADD COLUMN IF NOT EXISTS folder_applied_at timestamptz;
ALTER TABLE app.fact ADD COLUMN IF NOT EXISTS folder_error text;

-- CHECK + FK added separately so re-runs don't bomb on existing constraints.
DO $$
BEGIN
  -- 'manual' value is needed by correct_placement / retroactive rule adds.
  -- If the constraint exists with the old (no-'manual') definition, drop it.
  IF EXISTS (
    SELECT 1 FROM pg_constraint c WHERE conname = 'fact_folder_decided_by_check'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%manual%'
  ) THEN
    ALTER TABLE app.fact DROP CONSTRAINT fact_folder_decided_by_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fact_folder_decided_by_check'
  ) THEN
    ALTER TABLE app.fact
      ADD CONSTRAINT fact_folder_decided_by_check
      CHECK (folder_decided_by IS NULL OR folder_decided_by IN ('rule','llm','default','skip','manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fact_folder_rule_id_fkey'
  ) THEN
    ALTER TABLE app.fact
      ADD CONSTRAINT fact_folder_rule_id_fkey
      FOREIGN KEY (folder_rule_id) REFERENCES app.folder_rule(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_fact_folder_proposed_at
  ON app.fact (folder_proposed_at DESC) WHERE folder_proposed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fact_folder_target
  ON app.fact (folder_target) WHERE folder_target IS NOT NULL;

COMMIT;
