-- Willow database schema
-- PostgreSQL + pgvector

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE SCHEMA IF NOT EXISTS app;

-- ============================================================================
-- MEMORY SUBSYSTEM TABLES (app schema)
-- ============================================================================

-- ============================================================================
-- SOURCE_NOTE — the original input documents fed to the extractor
-- ============================================================================

CREATE TABLE app.source_note (
  source_note_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     text NOT NULL,  -- file, email, web, conversation, cli, agent (open vocabulary)
  filename        text,           -- for files: relative path from ingestion root
  url             text,           -- for web pages
  original_id     text,           -- for emails: Message-ID header; conversations: session id
  title           text,           -- email subject, page title, filename
  summary         text,           -- short LLM-generated summary of the source content
  raw_text        text NOT NULL,  -- full original content as fed to the extractor
  content_hash    text,           -- SHA-256 for change detection on re-ingest
  extracted_by    text,           -- which LLM extracted this: 'local', 'haiku'
  metadata        jsonb NOT NULL DEFAULT '{}',  -- source-type-specific fields
                                                -- email: {from, to, cc, date, thread_id}
                                                -- file: {directory, mime_type, size_bytes}
                                                -- web: {fetched_at, status_code}
                                                -- conversation: {participants, channel}
  -- PIB event stream columns
  from_factoid_id uuid,           -- resolved sender entity (factoid) — FK added after app.fact exists
  source_ref      text,           -- ID in the source system (JMAP message ID, RSS guid, etc.)
  received_at     timestamptz,    -- when the source event occurred (vs created_at = when we ingested it)

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_note_type ON app.source_note (source_type);
CREATE INDEX idx_source_note_filename ON app.source_note (filename) WHERE filename IS NOT NULL;
CREATE INDEX idx_source_note_original_id ON app.source_note (original_id) WHERE original_id IS NOT NULL;
CREATE UNIQUE INDEX idx_source_note_source_ref
  ON app.source_note (source_type, source_ref)
  WHERE source_ref IS NOT NULL;

-- ============================================================================
-- FACT — the atomic unit of memory; factoids are facts with is_factoid = true
-- ============================================================================

CREATE TABLE app.fact (
  fact_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_note_id    uuid REFERENCES app.source_note(source_note_id),
  source_ordinal    int,              -- extraction sequence within source (1, 2, 3...)
  title             text,             -- short label
  content           text NOT NULL,    -- full fact text
  keywords          text[],           -- LLM-extracted keywords for search
  embedding         vector(768),      -- nomic-embed-text

  -- Factoid clustering
  is_factoid        boolean NOT NULL DEFAULT false,
  parent_factoid_id uuid REFERENCES app.fact(fact_id),
                    -- set by the processor when clustering a fact under a factoid
                    -- NULL for unclustered facts (fresh from extractor) and top-level factoids
                    -- can point to a factoid that itself has a parent (multi-level clustering)
  factoid_type      text,
                    -- Person, Place, Organization, Event, Concept, Product
                    -- only set when is_factoid = true

  -- Query expansion
  qe_text           text,             -- alternate phrasings, synonyms, related terms
                    -- at extraction: naive, from raw input alone
                    -- at each reprocess: rewritten with broader context

  -- Memory lifecycle
  memory_type       text NOT NULL DEFAULT 'short_term',
                    -- short_term: staging area, not yet clustered/enriched
                    -- long_term: promoted after processing
  status            text NOT NULL DEFAULT 'raw',
                    -- raw, processing, clustered, expired
  is_active         boolean NOT NULL DEFAULT true,

  -- Expiry
  expires_type      text NOT NULL DEFAULT 'never',  -- never, date, weighted
  expires_date      timestamptz,
  expiry_weight     real DEFAULT 1.0,        -- 0.0–1.0
  expiry_decay      real DEFAULT 0.0,        -- weight reduction per day
  expiry_reeval_at  timestamptz,

  -- Confidence & verification
  confidence        real,            -- 0.0–1.0, set by extractor/processor
  human_verified    boolean NOT NULL DEFAULT false,

  -- Reprocessing schedule for qe_text
  reprocess_count   int NOT NULL DEFAULT 0,
  next_reprocess    timestamptz,

  -- PIB: triage/classification output (NULL for non-event-stream facts)
  intent_id         uuid,           -- FK to app.intent, added after intent table exists
  triage_action     text CHECK (triage_action IN ('noise', 'digest', 'queue', 'flag', 'pending')),
  triage_source     text CHECK (triage_source IN ('header', 'rule', 'llm', 'manual')),
  triage_rule_id    uuid,           -- FK to app.triage_rule, added after triage_rule table exists
  summary           text,           -- LLM-generated one-line summary
  extracted_data    jsonb,          -- intent-specific structured fields
  digest_queued_at  timestamptz,
  digest_sent_at    timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fact_status ON app.fact (status);
CREATE INDEX idx_fact_parent_factoid_id ON app.fact (parent_factoid_id);
CREATE INDEX idx_fact_factoid_type ON app.fact (factoid_type) WHERE factoid_type IS NOT NULL;
CREATE INDEX idx_fact_is_factoid ON app.fact (is_factoid) WHERE is_factoid = true;
CREATE INDEX idx_fact_source_note_id ON app.fact (source_note_id);
CREATE INDEX idx_fact_memory_type ON app.fact (memory_type);
CREATE INDEX idx_fact_is_active ON app.fact (is_active) WHERE is_active = true;
CREATE INDEX idx_fact_next_reprocess ON app.fact (next_reprocess) WHERE next_reprocess IS NOT NULL;
CREATE INDEX idx_fact_embedding ON app.fact USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- FACT_RELATIONSHIP — typed edges between factoids
-- ============================================================================

CREATE TABLE app.fact_relationship (
  relationship_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_factoid_id uuid NOT NULL REFERENCES app.fact(fact_id),
  to_factoid_id   uuid NOT NULL REFERENCES app.fact(fact_id),
  type            text NOT NULL,       -- parent_of, married_to, colleague_of, etc.
  inverse_type    text,                -- child_of, married_to, colleague_of, etc.
  description     text,
  expiry_weight   real DEFAULT 1.0,    -- relationships can end or change
  source_fact_id  uuid REFERENCES app.fact(fact_id),  -- the fact that established this
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fact_relationship_from ON app.fact_relationship(from_factoid_id);
CREATE INDEX idx_fact_relationship_to ON app.fact_relationship(to_factoid_id);
CREATE INDEX idx_fact_relationship_type ON app.fact_relationship(type);

-- Prevent exact duplicate relationships
CREATE UNIQUE INDEX idx_fact_relationship_unique
  ON app.fact_relationship(from_factoid_id, to_factoid_id, type);

-- ============================================================================
-- FACT_QUEUE — application-level pipeline state (Graphile Worker handles execution)
-- ============================================================================

CREATE TABLE app.fact_queue (
  queue_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id         uuid NOT NULL REFERENCES app.fact(fact_id),
  action          text NOT NULL,  -- remember, verify_world, verify_human
  status          text NOT NULL DEFAULT 'pending',  -- pending, processing, done, failed
  attempts        int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fact_queue_status ON app.fact_queue (status, created_at);
CREATE INDEX idx_fact_queue_fact_id ON app.fact_queue (fact_id);

-- ============================================================================
-- RECENCY_CONTEXT — global entity spotlight for disambiguation
-- ============================================================================

CREATE TABLE app.recency_context (
  factoid_id      uuid PRIMARY KEY REFERENCES app.fact(fact_id),
  last_mentioned  timestamptz NOT NULL DEFAULT now(),
  mention_count   int NOT NULL DEFAULT 1,  -- within active window
  weight          real NOT NULL DEFAULT 1.0,  -- decays with time
  window_expires  timestamptz NOT NULL
);

CREATE INDEX idx_recency_context_weight ON app.recency_context (weight DESC);

-- ============================================================================
-- UPDATED_AT trigger — auto-update updated_at on app.fact
-- ============================================================================

CREATE OR REPLACE FUNCTION app.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fact_updated_at
  BEFORE UPDATE ON app.fact
  FOR EACH ROW EXECUTE FUNCTION app.update_updated_at();


-- ============================================================================
-- BRIDGE / AGENT TABLES (public schema — not part of memory subsystem)
-- ============================================================================

-- ============================================================================
-- AGENT_REGISTRY — agent specs (agents are data, not code)
-- ============================================================================

CREATE TABLE agent_registry (
  agent_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  script_path     text NOT NULL,
  config          jsonb NOT NULL DEFAULT '{}',
  trigger_type    text NOT NULL,  -- one_time, cron, event
  cron_expression text,
  event_type      text,
  capabilities    text[] NOT NULL DEFAULT '{}',
  memory_scope    uuid[] NOT NULL DEFAULT '{}',  -- factoid IDs this agent can read
  model           text NOT NULL DEFAULT 'ministral',  -- ministral, sonnet
  status          text NOT NULL DEFAULT 'active',  -- active, paused, retired
  last_run_at     timestamptz,
  last_result     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_registry_status ON agent_registry (status);
CREATE INDEX idx_agent_registry_trigger ON agent_registry (trigger_type);

-- ============================================================================
-- SCHEDULE — cron and one-time trigger entries (Graphile Worker companion)
-- ============================================================================

CREATE TABLE schedule (
  schedule_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agent_registry(agent_id),
  trigger_type    text NOT NULL,  -- one_time, cron, event
  cron_expression text,
  event_type      text,
  next_run_at     timestamptz,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedule_next_run ON schedule (next_run_at) WHERE enabled = true;
CREATE INDEX idx_schedule_agent_id ON schedule (agent_id);

-- ============================================================================
-- RUN_LOG — agent execution history
-- ============================================================================

CREATE TABLE run_log (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agent_registry(agent_id),
  status          text NOT NULL,  -- running, success, failed, timeout
  result_summary  text,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     int,
  total_cost_usd  real DEFAULT 0,
  input_tokens    int DEFAULT 0,
  output_tokens   int DEFAULT 0
);

CREATE INDEX idx_run_log_agent_id ON run_log (agent_id, started_at DESC);
CREATE INDEX idx_run_log_status ON run_log (status) WHERE status = 'running';

-- ============================================================================
-- LLM_LOG — all LLM calls with cost estimates (interactive + scheduled)
-- ============================================================================

CREATE TABLE llm_log (
  log_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type    text NOT NULL,  -- interactive, scheduled, pipeline
  model           text NOT NULL,  -- sonnet, ministral
  prompt_preview  text,           -- first ~200 chars for debugging
  input_tokens    int,
  output_tokens   int,
  total_cost_usd  real,
  duration_ms     int,
  pipeline_stage  text,           -- extraction, entity_resolution, clustering, verify_world, etc.
  agent_id        uuid REFERENCES agent_registry(agent_id),
  run_id          uuid REFERENCES run_log(run_id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_log_created ON llm_log (created_at DESC);
CREATE INDEX idx_llm_log_model ON llm_log (model, created_at DESC);
CREATE INDEX idx_llm_log_agent ON llm_log (agent_id) WHERE agent_id IS NOT NULL;

-- ============================================================================
-- SESSION_POOL — optional persistent state for bridge restart resilience
-- ============================================================================

CREATE TABLE session_pool (
  session_id      text PRIMARY KEY,  -- tmux session name (e.g. "willow-1")
  status          text NOT NULL,     -- idle, busy, stale, dead
  channel_port    int NOT NULL,
  current_request uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- CONVERSATION — client-facing conversation identity, decoupled from sessions
-- ============================================================================

CREATE TABLE conversation (
  conversation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text,               -- optional, can be set later (e.g. first message summary)
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- CONVERSATION_MESSAGE — bridge-side conversation log for client UI replay
-- ============================================================================

CREATE TABLE conversation_message (
  message_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversation(conversation_id),
  session_id      text NOT NULL,      -- tmux session name, for diagnostics
  request_id      uuid NOT NULL,      -- ties user message to its assistant reply
  role            text NOT NULL,      -- 'user' or 'assistant'
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversation_message_conversation
  ON conversation_message (conversation_id, created_at);


-- ============================================================================
-- PIB (Personal Information Bus) TABLES (app schema)
-- ============================================================================

-- ============================================================================
-- ENTITY_ADDRESS — fast address → factoid lookup index
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
-- INTENT — source-agnostic intent taxonomy
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
-- TRIAGE_RULE — data-driven pre-LLM rule evaluation
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
-- INTEREST — user-defined standing interests
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
  action_prompt    text,
  on_match_action  text NOT NULL CHECK (on_match_action IN ('flag', 'queue', 'digest')),
  notify           boolean DEFAULT false,
  enabled          boolean DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- ============================================================================
-- INTENT_HANDLER — maps intents to handlers
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
-- AGENT_SUBSCRIPTION — standing agent subscriptions (fan-out)
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
-- SOURCE_ADAPTER_STATE — per-source, per-folder sync state tokens
-- ============================================================================

CREATE TABLE app.source_adapter_state (
  source_type  text NOT NULL,
  folder       text NOT NULL,
  state_token  text,
  last_run_at  timestamptz,
  metadata     jsonb DEFAULT '{}',
  updated_at   timestamptz DEFAULT now(),
  PRIMARY KEY (source_type, folder)
);

-- ============================================================================
-- HANDLER_EXECUTION — execution audit log
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
-- PIB FK constraints (deferred because tables reference each other)
-- ============================================================================

ALTER TABLE app.source_note ADD CONSTRAINT fk_source_note_from_factoid
  FOREIGN KEY (from_factoid_id) REFERENCES app.fact(fact_id);

ALTER TABLE app.fact ADD CONSTRAINT fk_fact_intent
  FOREIGN KEY (intent_id) REFERENCES app.intent(id);

ALTER TABLE app.fact ADD CONSTRAINT fk_fact_triage_rule
  FOREIGN KEY (triage_rule_id) REFERENCES app.triage_rule(id);
