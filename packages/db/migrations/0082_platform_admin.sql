-- LC-53 platform super-admin: tenant lifecycle, step-up grants, fraud flags, support notes,
-- versioned global announcements. Organization columns are added migration-safely.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CONSTRAINT organizations_lifecycle_status_check CHECK (status IN ('active', 'suspended', 'scheduled_deletion', 'deleted'));
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deletion_scheduled_for timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lifecycle_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_deletion_schedule_check') THEN
    ALTER TABLE organizations ADD CONSTRAINT organizations_deletion_schedule_check
      CHECK (status <> 'scheduled_deletion' OR deletion_scheduled_for IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organizations_status_idx ON organizations (status, created_at DESC);
--> statement-breakpoint
CREATE FUNCTION platform_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TABLE organization_lifecycle_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('suspend', 'reactivate', 'schedule_deletion', 'cancel_deletion', 'finalize_deletion')),
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  step_up_grant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX organization_lifecycle_events_org_idx ON organization_lifecycle_events (organization_id, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER organization_lifecycle_events_append_only BEFORE UPDATE ON organization_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION platform_append_only();
--> statement-breakpoint
-- Step-up grants: short-lived (<= 10 minutes) proof of re-verification, bound to one session.
CREATE TABLE step_up_grants (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('recovery_code', 'fresh_session')),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
--> statement-breakpoint
CREATE INDEX step_up_grants_session_idx ON step_up_grants (session_id, expires_at);
--> statement-breakpoint
CREATE TABLE platform_fraud_flags (
  id uuid PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('organization', 'account')),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by_account_id uuid REFERENCES accounts(id),
  resolved_at timestamptz,
  resolution text CHECK (resolution IS NULL OR length(resolution) BETWEEN 3 AND 2000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((subject_type = 'organization' AND organization_id IS NOT NULL AND account_id IS NULL) OR
         (subject_type = 'account' AND account_id IS NOT NULL AND organization_id IS NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by_account_id IS NOT NULL AND resolution IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX platform_fraud_flags_org_idx ON platform_fraud_flags (organization_id, status);
--> statement-breakpoint
CREATE INDEX platform_fraud_flags_account_idx ON platform_fraud_flags (account_id, status);
--> statement-breakpoint
CREATE TABLE platform_support_notes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX platform_support_notes_org_idx ON platform_support_notes (organization_id, created_at DESC);
--> statement-breakpoint
CREATE TRIGGER platform_support_notes_append_only BEFORE UPDATE ON platform_support_notes
  FOR EACH ROW EXECUTE FUNCTION platform_append_only();
--> statement-breakpoint
CREATE TABLE platform_announcements (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('release_note', 'announcement')),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_version integer,
  withdrawn_at timestamptz,
  withdrawn_by_account_id uuid REFERENCES accounts(id),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by_account_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE platform_announcement_versions (
  announcement_id uuid NOT NULL REFERENCES platform_announcements(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  target_organization_ids uuid[] CHECK (target_organization_ids IS NULL OR cardinality(target_organization_ids) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by_account_id uuid REFERENCES accounts(id),
  published_at timestamptz,
  PRIMARY KEY (announcement_id, version),
  CHECK ((status = 'published') = (published_at IS NOT NULL AND published_by_account_id IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION platform_announcement_versions_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN RAISE EXCEPTION 'published announcement versions are immutable'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN RAISE EXCEPTION 'published announcement versions are immutable'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER platform_announcement_versions_freeze BEFORE UPDATE OR DELETE ON platform_announcement_versions
  FOR EACH ROW EXECUTE FUNCTION platform_announcement_versions_freeze();
