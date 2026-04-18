-- Calendar Phase 2 — write support
-- Adds columns needed for CalDAV write, event provenance, and the Willow staging calendar.

BEGIN;

-- CalDAV resource URL (needed for update/delete operations)
ALTER TABLE app.cal_event ADD COLUMN caldav_url text;

-- Track how an event was created: sync (from CalDAV poll), willow (PIB auto-created),
-- interactive (user asked the agent to create it)
ALTER TABLE app.cal_event ADD COLUMN source text NOT NULL DEFAULT 'sync'
  CHECK (source IN ('sync', 'willow', 'interactive'));

-- Mark the dedicated Willow staging calendar
ALTER TABLE app.cal_calendar ADD COLUMN is_willow boolean DEFAULT false;

-- Full-text search index for search_events tool
CREATE INDEX idx_cal_event_fts ON app.cal_event
  USING gin (to_tsvector('english',
    coalesce(summary, '') || ' ' || coalesce(description, '') || ' ' || coalesce(location, '')));

COMMIT;
