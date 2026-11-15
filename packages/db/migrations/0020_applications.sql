-- LC-17 applications and registration.
-- Link participants to accounts (another milestone may add the same column; both are guarded).
ALTER TABLE participants ADD COLUMN IF NOT EXISTS account_id uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'participants_account_membership_fk') THEN
    ALTER TABLE participants ADD CONSTRAINT participants_account_membership_fk
      FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships (organization_id, account_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS participants_org_account_idx ON participants (organization_id, account_id) WHERE account_id IS NOT NULL;
--> statement-breakpoint
-- Generic append-only guard for decision/history tables of LC-17..LC-21.
CREATE FUNCTION lce_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TABLE application_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 100000),
  contact_consent_key text CHECK (contact_consent_key IS NULL OR contact_consent_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) <= 50),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_account_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at),
  UNIQUE (organization_id, competition_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, updated_by_account_id) REFERENCES organization_memberships (organization_id, account_id)
);
--> statement-breakpoint
CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  applicant_account_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_review','selected','waitlisted','declined','withdrawn')),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  form_revision integer NOT NULL CHECK (form_revision > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  waitlist_position integer CHECK (waitlist_position IS NULL OR waitlist_position > 0),
  waitlisted_at timestamptz,
  participant_id uuid,
  entry_id uuid,
  submitted_at timestamptz,
  decided_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK ((status = 'waitlisted') = (waitlist_position IS NOT NULL)),
  CHECK (status <> 'selected' OR entry_id IS NOT NULL),
  CHECK (status = 'draft' OR submitted_at IS NOT NULL OR status = 'withdrawn'),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, applicant_account_id) REFERENCES organization_memberships (organization_id, account_id),
  FOREIGN KEY (organization_id, participant_id) REFERENCES participants (organization_id, id),
  FOREIGN KEY (organization_id, entry_id) REFERENCES entries (organization_id, id)
);
--> statement-breakpoint
-- One active (non-withdrawn) application per account per competition.
CREATE UNIQUE INDEX applications_one_active_uniq ON applications (organization_id, competition_id, applicant_account_id)
  WHERE status <> 'withdrawn';
--> statement-breakpoint
CREATE INDEX applications_review_idx ON applications (organization_id, competition_id, status, submitted_at);
--> statement-breakpoint
CREATE UNIQUE INDEX applications_waitlist_position_uniq ON applications (competition_id, waitlist_position)
  WHERE waitlist_position IS NOT NULL;
--> statement-breakpoint
CREATE TABLE application_consents (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  consent_key text NOT NULL CHECK (consent_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  consent_version text NOT NULL CHECK (consent_version ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  accepted_by_account_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, consent_key, consent_version),
  FOREIGN KEY (organization_id, application_id) REFERENCES applications (organization_id, id),
  FOREIGN KEY (organization_id, accepted_by_account_id) REFERENCES organization_memberships (organization_id, account_id)
);
--> statement-breakpoint
CREATE TRIGGER application_consents_append_only BEFORE UPDATE OR DELETE ON application_consents
  FOR EACH ROW EXECUTE FUNCTION lce_append_only_guard();
--> statement-breakpoint
CREATE TABLE application_media (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  field_key text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  media_id uuid NOT NULL,
  PRIMARY KEY (application_id, field_key, media_id),
  FOREIGN KEY (organization_id, application_id) REFERENCES applications (organization_id, id),
  FOREIGN KEY (organization_id, media_id) REFERENCES media_library (organization_id, id)
);
--> statement-breakpoint
CREATE TABLE application_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  application_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('applicant','producer','system')),
  actor_account_id uuid,
  previous_status text NOT NULL,
  new_status text NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  decided_at timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_kind = 'system' OR actor_account_id IS NOT NULL),
  UNIQUE (application_id, revision),
  FOREIGN KEY (organization_id, application_id) REFERENCES applications (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
--> statement-breakpoint
CREATE TRIGGER application_decisions_append_only BEFORE UPDATE OR DELETE ON application_decisions
  FOR EACH ROW EXECUTE FUNCTION lce_append_only_guard();
