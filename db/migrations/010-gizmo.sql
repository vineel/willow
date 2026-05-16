-- Gizmos: ephemeral on-the-fly web UIs Willow generates during conversations
-- to gather structured input from the user. See notes/gizmo-design.md.

BEGIN;

CREATE TABLE app.gizmo (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  title           text NOT NULL,
  body_html       text NOT NULL,
  data_context    jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_prompt   text NOT NULL,
  return_channel  text NOT NULL,
  hmac_token      text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','submitted','dispatched','expired','cancelled')),
  submission      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  dispatched_at   timestamptz
);

CREATE INDEX gizmo_status_idx ON app.gizmo (status, expires_at);

COMMIT;
