-- Willow database schema
-- PostgreSQL + pgvector

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- FACT_SOURCE — the original input documents fed to the extractor
-- ============================================================================

CREATE TABLE fact_source (
  source_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type     text NOT NULL,  -- file, email, web, conversation, cli, agent (open vocabulary)
  filename        text,           -- for files: relative path from ingestion root
  url             text,           -- for web pages
  original_id     text,           -- for emails: Message-ID header; conversations: session id
  title           text,           -- email subject, page title, filename
  summary         text,           -- short LLM-generated summary of the source content
  raw_text        text,           -- full original content as fed to the extractor
  metadata        jsonb NOT NULL DEFAULT '{}',  -- source-type-specific fields
                                                -- email: {from, to, cc, date, thread_id}
                                                -- file: {directory, mime_type, size_bytes}
                                                -- web: {fetched_at, status_code}
                                                -- conversation: {participants, channel}
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fact_source_type ON fact_source (source_type);
CREATE INDEX idx_fact_source_original_id ON fact_source (original_id) WHERE original_id IS NOT NULL;

-- ============================================================================
-- FACT — the atomic unit of memory; factoids are facts with is_root = true
-- ============================================================================

CREATE TABLE fact (
  fact_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,            -- short label
  text            text NOT NULL,            -- full content
  qe_text         text,                     -- query expansion text (alternate phrasings, synonyms)
  embedding       vector(768),              -- nomic-embed-text dimension

  status          text NOT NULL DEFAULT 'raw',  -- raw, processing, clustered, expired

  -- Clustering: factoids are facts with is_root = true
  is_root         boolean NOT NULL DEFAULT false,
  root_id         uuid REFERENCES fact(fact_id),  -- points to factoid this fact clusters under
                                                   -- a root factoid points to itself
  root_type       text,  -- Person, Place, Organization, Event, Concept, Product (null for non-roots)

  -- Provenance
  source_id       uuid REFERENCES fact_source(source_id),
  source_ordinal  int,             -- extraction sequence within source (1, 2, 3...)
  confidence      real,            -- 0.0–1.0, set by extractor/processor
  human_verified  boolean NOT NULL DEFAULT false,

  -- Expiry
  expires_type    text NOT NULL DEFAULT 'never',  -- never, date, weighted
  expires_date    timestamptz,
  expiry_weight   real DEFAULT 1.0,        -- 0.0–1.0
  expiry_decay    real DEFAULT 0.0,        -- weight reduction per day
  expiry_reeval_at timestamptz,

  -- Reprocessing schedule for qe_text
  reprocess_count int NOT NULL DEFAULT 0,
  next_reprocess  timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fact_status ON fact (status);
CREATE INDEX idx_fact_root_id ON fact (root_id);
CREATE INDEX idx_fact_root_type ON fact (root_type) WHERE root_type IS NOT NULL;
CREATE INDEX idx_fact_is_root ON fact (is_root) WHERE is_root = true;
CREATE INDEX idx_fact_source_id ON fact (source_id);
CREATE INDEX idx_fact_next_reprocess ON fact (next_reprocess) WHERE next_reprocess IS NOT NULL;
CREATE INDEX idx_fact_embedding ON fact USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- FACT_RELATIONSHIP — typed edges between factoids
-- ============================================================================

CREATE TABLE fact_relationship (
  relationship_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_root_id    uuid NOT NULL REFERENCES fact(fact_id),
  to_root_id      uuid NOT NULL REFERENCES fact(fact_id),
  type            text NOT NULL,       -- parent_of, married_to, colleague_of, etc.
  inverse_type    text NOT NULL,       -- child_of, married_to, colleague_of, etc.
  description     text,
  expiry_weight   real DEFAULT 1.0,    -- relationships can end or change
  source_fact_id  uuid REFERENCES fact(fact_id),  -- the fact that established this
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fact_relationship_from ON fact_relationship(from_root_id);
CREATE INDEX idx_fact_relationship_to ON fact_relationship(to_root_id);
CREATE INDEX idx_fact_relationship_type ON fact_relationship(type);

-- Prevent exact duplicate relationships
CREATE UNIQUE INDEX idx_fact_relationship_unique
  ON fact_relationship(from_root_id, to_root_id, type);

-- ============================================================================
-- FACT_QUEUE — durable processing queue for the fact pipeline
-- ============================================================================

CREATE TABLE fact_queue (
  queue_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id         uuid NOT NULL REFERENCES fact(fact_id),
  action          text NOT NULL,  -- remember, verify_world, verify_human
  status          text NOT NULL DEFAULT 'pending',  -- pending, processing, done, failed
  attempts        int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fact_queue_status ON fact_queue (status, created_at);
CREATE INDEX idx_fact_queue_fact_id ON fact_queue (fact_id);

-- ============================================================================
-- RECENCY_CONTEXT — global entity spotlight for disambiguation
-- ============================================================================

CREATE TABLE recency_context (
  root_id         uuid PRIMARY KEY REFERENCES fact(fact_id),
  last_mentioned  timestamptz NOT NULL DEFAULT now(),
  mention_count   int NOT NULL DEFAULT 1,  -- within active window
  weight          real NOT NULL DEFAULT 1.0,  -- decays with time
  window_expires  timestamptz NOT NULL
);

CREATE INDEX idx_recency_context_weight ON recency_context (weight DESC);

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
  model           text NOT NULL DEFAULT 'qwen',  -- qwen, sonnet
  status          text NOT NULL DEFAULT 'active',  -- active, paused, retired
  last_run_at     timestamptz,
  last_result     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_registry_status ON agent_registry (status);
CREATE INDEX idx_agent_registry_trigger ON agent_registry (trigger_type);

-- ============================================================================
-- SCHEDULE — cron and one-time trigger entries (pg-boss companion)
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
  model           text NOT NULL,  -- sonnet, qwen
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
-- UPDATED_AT trigger — auto-update updated_at on fact
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fact_updated_at
  BEFORE UPDATE ON fact
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
