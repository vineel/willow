-- Calendar integration tables — Phase 1 (read-only ingestion)
-- Additive only — no existing tables/columns are modified or dropped.

BEGIN;

-- ============================================================================
-- 1. CAL_CALENDARS — one row per synced calendar
-- ============================================================================

CREATE TABLE app.cal_calendar (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url           text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  ctag          text,
  sync_token    text,
  color         text,
  is_shared     boolean DEFAULT false,
  owner         text,
  last_synced_at timestamptz,
  enabled       boolean DEFAULT true,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- ============================================================================
-- 2. CAL_EVENTS — canonical event store
-- ============================================================================

CREATE TABLE app.cal_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id   uuid NOT NULL REFERENCES app.cal_calendar(id),
  uid           text NOT NULL,
  etag          text,
  summary       text NOT NULL DEFAULT '',
  description   text,
  location      text,
  starts_at     timestamptz,
  ends_at       timestamptz,
  all_day       boolean DEFAULT false,
  rrule         text,
  master_uid    text,
  attendees     jsonb DEFAULT '[]',
  organizer     text,
  status        text DEFAULT 'CONFIRMED',
  raw_ics       text NOT NULL,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (uid, calendar_id)
);

CREATE INDEX idx_cal_event_calendar_starts ON app.cal_event (calendar_id, starts_at);
CREATE INDEX idx_cal_event_master ON app.cal_event (master_uid) WHERE master_uid IS NOT NULL;

-- ============================================================================
-- 3. CAL_EVENT_PROCESSING — tracks LLM extraction per event
-- ============================================================================

CREATE TABLE app.cal_event_processing (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES app.cal_event(id),
  content_hash  text NOT NULL,
  processed_at  timestamptz,
  extracted_todos jsonb,
  extracted_facts jsonb,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'error')),
  error         text,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX idx_cal_event_processing_pending
  ON app.cal_event_processing (status) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_cal_event_processing_event
  ON app.cal_event_processing (event_id, content_hash);

COMMIT;
