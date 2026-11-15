-- LC-27 reusable PostgreSQL-backed rate limiter: one counter row per
-- tenant + account + action + window. Rows are disposable and may be pruned.
CREATE TABLE rate_limit_counters (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  window_ms integer NOT NULL CHECK (window_ms BETWEEN 1000 AND 86400000),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (organization_id, account_id, action, window_ms, window_start)
);
--> statement-breakpoint
CREATE INDEX rate_limit_counters_window_idx ON rate_limit_counters (window_start);
