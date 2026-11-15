-- LC-03 follow-up: first-party password credentials, login throttling, and an append-only engine audit log.
CREATE TABLE account_credentials (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_hash char(64) NOT NULL,
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_time_idx ON login_attempts (email_hash, attempted_at DESC);

CREATE TABLE engine_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  actor_account_id uuid REFERENCES accounts(id),
  action text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engine_audit_log_org_time_idx ON engine_audit_log (organization_id, recorded_at DESC);
CREATE INDEX engine_audit_log_subject_idx ON engine_audit_log (subject_type, subject_id);

CREATE FUNCTION engine_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'engine_audit_log is append-only';
END;
$$;
CREATE TRIGGER engine_audit_log_no_mutation BEFORE UPDATE OR DELETE ON engine_audit_log
  FOR EACH ROW EXECUTE FUNCTION engine_audit_log_append_only();
