-- Todo system for Willow
-- Standalone task tracking with email and conversation input channels.

BEGIN;

-- ============================================================================
-- 1. TODO TABLE
-- ============================================================================

CREATE TABLE app.todo (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'snoozed')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date        date,
  source          text NOT NULL CHECK (source IN ('email', 'conversation', 'agent')),
  source_fact_id  uuid REFERENCES app.fact(fact_id),
  tags            text[] DEFAULT '{}',
  completed_at    timestamptz,
  snoozed_until   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_todo_status ON app.todo (status) WHERE status = 'open';
CREATE INDEX idx_todo_due_date ON app.todo (due_date) WHERE status = 'open' AND due_date IS NOT NULL;
CREATE INDEX idx_todo_source_fact ON app.todo (source_fact_id) WHERE source_fact_id IS NOT NULL;

CREATE TRIGGER todo_updated_at
  BEFORE UPDATE ON app.todo
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at();

-- ============================================================================
-- 2. ACTION INTENTS — classifier can now recognize action-item emails
-- ============================================================================

INSERT INTO app.intent (category, subcategory, label, default_action, requires_parsing, notify_user) VALUES
  ('action', 'task',    'Action item / task',           'flag', true, false),
  ('action', 'request', 'Request requiring response',   'flag', true, false);

COMMIT;
