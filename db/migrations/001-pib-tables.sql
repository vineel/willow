-- PIB (Personal Information Bus) schema migration
-- Additive only — no existing tables/columns are modified or dropped.

BEGIN;

-- ============================================================================
-- 1. ENTITY_ADDRESS — fast address → factoid lookup
-- ============================================================================

CREATE TABLE app.entity_address (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factoid_id    uuid NOT NULL REFERENCES app.fact(fact_id),
  source_type   text NOT NULL,   -- 'email', 'slack', 'phone', 'github', etc.
  address       text NOT NULL,
  display_name  text,
  verified      boolean DEFAULT false,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (source_type, address)
);

CREATE INDEX idx_entity_address_lookup ON app.entity_address (source_type, address);
CREATE INDEX idx_entity_address_factoid ON app.entity_address (factoid_id);

-- ============================================================================
-- 2. INTENT — source-agnostic intent taxonomy
-- ============================================================================

CREATE TABLE app.intent (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category         text NOT NULL,
  subcategory      text NOT NULL,
  label            text NOT NULL,
  default_action   text NOT NULL CHECK (default_action IN ('noise', 'digest', 'queue', 'flag')),
  requires_parsing boolean DEFAULT false,
  notify_user      boolean DEFAULT false,
  retention_days   integer,
  created_at       timestamptz DEFAULT now(),
  UNIQUE (category, subcategory)
);

-- ============================================================================
-- 3. TRIAGE_RULE — data-driven pre-LLM rule evaluation
-- ============================================================================

CREATE TABLE app.triage_rule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  field        text NOT NULL,  -- 'from_domain', 'from_address', 'subject', 'header', 'source_type'
  operator     text NOT NULL CHECK (operator IN ('equals', 'contains', 'starts_with', 'ends_with', 'regex', 'exists', 'gte')),
  value        text,
  header_name  text,
  action       text NOT NULL CHECK (action IN ('noise', 'digest', 'queue', 'flag')),
  priority     integer DEFAULT 100,
  enabled      boolean DEFAULT true,
  confirmed    boolean DEFAULT false,
  source       text NOT NULL CHECK (source IN ('system', 'user', 'agent')),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX idx_triage_rule_active ON app.triage_rule (priority) WHERE enabled = true AND confirmed = true;

-- ============================================================================
-- 4. INTEREST — user-defined standing interests
-- ============================================================================

CREATE TABLE app.interest (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  description      text,
  keywords         text[] NOT NULL,
  source_domains   text[],
  intent_category  text,
  intent_subcat    text,
  extraction_fields jsonb,
  action_prompt    text,           -- natural language instruction for claude -p
  on_match_action  text NOT NULL CHECK (on_match_action IN ('flag', 'queue', 'digest')),
  notify           boolean DEFAULT false,
  enabled          boolean DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- ============================================================================
-- 5. INTENT_HANDLER — maps intents to handlers
-- ============================================================================

CREATE TABLE app.intent_handler (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_category  text NOT NULL,
  intent_subcat    text,
  handler_type     text NOT NULL CHECK (handler_type IN ('builtin', 'agent', 'webhook', 'script')),
  handler_ref      text NOT NULL,
  config           jsonb,
  priority         integer DEFAULT 100,
  enabled          boolean DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX idx_intent_handler_lookup
  ON app.intent_handler (intent_category, intent_subcat) WHERE enabled = true;

-- ============================================================================
-- 6. AGENT_SUBSCRIPTION — standing agent subscriptions (fan-out)
-- ============================================================================

CREATE TABLE app.agent_subscription (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name       text NOT NULL,
  intent_category  text,
  intent_subcat    text,
  source_type      text,
  from_domain      text,
  config           jsonb,
  enabled          boolean DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

-- ============================================================================
-- 7. SOURCE_ADAPTER_STATE — per-source sync state tokens
-- ============================================================================

CREATE TABLE app.source_adapter_state (
  source_type  text PRIMARY KEY,
  folder       text,              -- for adapters with per-folder state
  state_token  text,
  last_run_at  timestamptz,
  metadata     jsonb DEFAULT '{}',
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (source_type, folder)
);

-- Drop the simple PK so composite unique can serve as the key
ALTER TABLE app.source_adapter_state DROP CONSTRAINT source_adapter_state_pkey;
ALTER TABLE app.source_adapter_state ADD PRIMARY KEY (source_type, folder);

-- ============================================================================
-- 8. HANDLER_EXECUTION — execution audit log
-- ============================================================================

CREATE TABLE app.handler_execution (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id      uuid REFERENCES app.fact(fact_id),
  handler_id   uuid REFERENCES app.intent_handler(id),
  status       text NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  error        text,
  duration_ms  integer,
  executed_at  timestamptz DEFAULT now()
);

-- ============================================================================
-- 9. EXTEND source_note for event streams
-- ============================================================================

ALTER TABLE app.source_note ADD COLUMN from_factoid_id uuid REFERENCES app.fact(fact_id);
ALTER TABLE app.source_note ADD COLUMN source_ref text;
ALTER TABLE app.source_note ADD COLUMN received_at timestamptz;

-- Idempotent ingest: no duplicate source_type + source_ref
CREATE UNIQUE INDEX idx_source_note_source_ref
  ON app.source_note (source_type, source_ref)
  WHERE source_ref IS NOT NULL;

-- ============================================================================
-- 10. EXTEND fact for triage/classification output
-- ============================================================================

ALTER TABLE app.fact ADD COLUMN intent_id uuid REFERENCES app.intent(id);
ALTER TABLE app.fact ADD COLUMN triage_action text CHECK (triage_action IN ('noise', 'digest', 'queue', 'flag', 'pending'));
ALTER TABLE app.fact ADD COLUMN triage_source text CHECK (triage_source IN ('header', 'rule', 'llm', 'manual'));
ALTER TABLE app.fact ADD COLUMN triage_rule_id uuid REFERENCES app.triage_rule(id);
ALTER TABLE app.fact ADD COLUMN summary text;
ALTER TABLE app.fact ADD COLUMN extracted_data jsonb;
ALTER TABLE app.fact ADD COLUMN digest_queued_at timestamptz;
ALTER TABLE app.fact ADD COLUMN digest_sent_at timestamptz;

-- ============================================================================
-- 11. SEED intent taxonomy (from real inbox data, April 2026)
-- ============================================================================

INSERT INTO app.intent (category, subcategory, label, default_action, requires_parsing, notify_user) VALUES
  ('transactional', 'order_confirmation', 'Order confirmation',       'queue', true,  false),
  ('transactional', 'shipping',           'Shipping notification',    'queue', true,  false),
  ('transactional', 'delivery',           'Delivery confirmation',    'queue', true,  false),
  ('transactional', 'billing',            'Bill / invoice',           'queue', true,  false),
  ('transactional', 'auth',               'Authentication / login',   'flag',  false, true),
  ('transactional', 'booking',            'Booking confirmation',     'queue', true,  false),
  ('alert',         'security',           'Security alert',           'flag',  false, true),
  ('alert',         'financial',          'Financial alert',          'flag',  true,  true),
  ('alert',         'service',            'Service notification',     'digest', false, false),
  ('subscription',  'newsletter',         'Newsletter',               'digest', false, false),
  ('subscription',  'marketing',          'Marketing email',          'digest', false, false),
  ('subscription',  'community',          'Community update',         'digest', false, false),
  ('subscription',  'update',             'Service / product update', 'digest', false, false),
  ('entertainment', 'ticket_sale',        'Ticket sale',              'digest', true,  false),
  ('entertainment', 'event_reminder',     'Event reminder',           'flag',  true,  true),
  ('calendar',      'invite',             'Calendar invite',          'flag',  true,  true),
  ('calendar',      'change',             'Schedule change',          'flag',  true,  true),
  ('calendar',      'reminder',           'Calendar reminder',        'flag',  false, true),
  ('noise',         'political',          'Political / campaign',     'noise', false, false),
  ('noise',         'spam',               'Spam',                     'noise', false, false),
  ('noise',         'deals',              'Deals / coupons',          'noise', false, false),
  ('noise',         'bulk',               'Bulk / mass mail',         'noise', false, false),
  ('relationship',  'personal',           'Personal contact',         'queue', false, false),
  ('relationship',  'professional',       'Professional contact',     'queue', false, false);

-- ============================================================================
-- 12. SEED system triage rules
-- ============================================================================

INSERT INTO app.triage_rule (name, description, field, operator, value, header_name, action, priority, enabled, confirmed, source) VALUES
  ('List-Unsubscribe → digest',    'Emails with List-Unsubscribe header are bulk/subscription', 'header', 'exists', NULL, 'List-Unsubscribe', 'digest', 500, true, true, 'system'),
  ('High spam score → noise',      'Spam score >= 5 is noise',                                  'header', 'gte',    '5',  'X-Spam-Score',     'noise',  400, true, true, 'system'),
  ('noreply sender → digest',      'noreply/no-reply senders are automated',                    'from_address', 'contains', 'noreply', NULL,   'digest', 600, true, true, 'system'),
  ('no-reply sender → digest',     'no-reply senders are automated',                            'from_address', 'contains', 'no-reply', NULL,  'digest', 600, true, true, 'system'),
  ('donotreply sender → digest',   'donotreply senders are automated',                          'from_address', 'contains', 'donotreply', NULL, 'digest', 600, true, true, 'system');

COMMIT;
