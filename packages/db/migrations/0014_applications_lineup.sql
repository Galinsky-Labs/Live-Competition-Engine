-- LC-17 applications/registration and LC-18 producer selection with versioned decisions and lineups.
CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  applicant_account_id uuid NOT NULL REFERENCES accounts(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual', 'group')),
  members jsonb NOT NULL DEFAULT '[]'::jsonb,
  statement text CHECK (statement IS NULL OR length(statement) <= 4000),
  media_ids uuid[] NOT NULL DEFAULT '{}',
  consent_version text NOT NULL,
  consented_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'selected', 'waitlisted', 'rejected', 'withdrawn')),
  waitlist_position integer CHECK (waitlist_position IS NULL OR waitlist_position > 0),
  entry_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_one_per_account UNIQUE (competition_id, applicant_account_id),
  CONSTRAINT applications_org_id_uniq UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id),
  CHECK ((status = 'waitlisted') = (waitlist_position IS NOT NULL)),
  CHECK (status <> 'selected' OR entry_id IS NOT NULL)
);
CREATE INDEX applications_event_status_idx ON applications (competition_id, status, submitted_at);

CREATE TABLE application_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  application_revision integer NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  actor_role text NOT NULL CHECK (actor_role IN ('applicant', 'producer')),
  reason text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, application_id) REFERENCES applications (organization_id, id),
  UNIQUE (application_id, application_revision)
);
CREATE FUNCTION application_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'application decisions are append-only';
END;
$$;
CREATE TRIGGER application_decisions_no_mutation BEFORE UPDATE OR DELETE ON application_decisions
  FOR EACH ROW EXECUTE FUNCTION application_decisions_append_only();

-- Lineup slots reuse `performances`; keep entries inside the event.
ALTER TABLE performances
  ADD CONSTRAINT performances_competition_entry_fk FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id);
CREATE UNIQUE INDEX performances_round_entry_uniq ON performances (round_id, entry_id);
CREATE UNIQUE INDEX performances_competition_id_uniq ON performances (competition_id, id);
