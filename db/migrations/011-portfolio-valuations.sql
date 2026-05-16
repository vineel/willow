-- Persist portfolio valuations from scheduled runs so the post-close report
-- can compare against earlier snapshots (e.g. Monday pre-market for Week's Change).

BEGIN;

CREATE TABLE app.portfolio_valuation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            timestamptz NOT NULL DEFAULT now(),
  variant       text NOT NULL CHECK (variant IN ('premarket','midday','postclose')),
  total_value   numeric(18,2) NOT NULL,
  valued_count  integer NOT NULL,
  missing_count integer NOT NULL DEFAULT 0
);

CREATE INDEX portfolio_valuation_ts_idx ON app.portfolio_valuation (ts DESC);
CREATE INDEX portfolio_valuation_variant_ts_idx ON app.portfolio_valuation (variant, ts DESC);

COMMIT;
