-- Shared append-only, hash-chained audit log used by every later milestone.
-- organization_id NULL means a platform-scope event. Each scope has its own chain.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- No foreign keys: audit evidence must outlive tenant and account deletion.
  organization_id uuid,
  chain_key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  actor_account_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(action) <= 100),
  subject_type text NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_]*$' AND length(subject_type) <= 60),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  previous_hash char(64) NOT NULL,
  hash char(64) NOT NULL,
  CHECK (chain_key = COALESCE(organization_id::text, 'platform')),
  UNIQUE (chain_key, sequence)
);
--> statement-breakpoint
CREATE INDEX audit_events_org_time_idx ON audit_events (organization_id, recorded_at DESC);
--> statement-breakpoint
CREATE INDEX audit_events_subject_idx ON audit_events (subject_type, subject_id);
--> statement-breakpoint
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();
