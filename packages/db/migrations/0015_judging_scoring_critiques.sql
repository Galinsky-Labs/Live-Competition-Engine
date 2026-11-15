-- LC-19 judge system, LC-20 immutable scoring, LC-21 critiques with correction and appeal trail.
ALTER TABLE judges ADD COLUMN account_id uuid REFERENCES accounts(id);
CREATE UNIQUE INDEX judges_org_account_uniq ON judges (organization_id, account_id) WHERE account_id IS NOT NULL;

ALTER TABLE competition_judges
  ADD COLUMN status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'accepted', 'declined', 'removed')),
  ADD COLUMN panel text NOT NULL DEFAULT 'main' CHECK (panel ~ '^[a-z0-9_-]{1,32}$'),
  ADD COLUMN invited_by_account_id uuid REFERENCES accounts(id),
  ADD COLUMN invited_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN responded_at timestamptz,
  ADD COLUMN role_grant_id uuid REFERENCES role_grants(id);
ALTER TABLE competition_judges ADD CONSTRAINT competition_judges_competition_fk
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id);

CREATE TABLE judge_recusals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  declared_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competition_id, judge_id, entry_id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id),
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);

CREATE TABLE score_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL,
  performance_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  scores jsonb NOT NULL,
  total numeric(7, 3) NOT NULL,
  supersedes_id uuid REFERENCES score_sheets(id),
  correction_reason text,
  submitted_by_account_id uuid NOT NULL REFERENCES accounts(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (competition_id, performance_id) REFERENCES performances (competition_id, id),
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id),
  CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL))
);
-- One original sheet per judge and performance; each sheet can be superseded at most once.
CREATE UNIQUE INDEX score_sheets_original_uniq ON score_sheets (performance_id, judge_id) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX score_sheets_supersedes_uniq ON score_sheets (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX score_sheets_round_idx ON score_sheets (round_id);
CREATE FUNCTION score_sheets_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'submitted scores are immutable; submit a correction instead';
END;
$$;
CREATE TRIGGER score_sheets_no_mutation BEFORE UPDATE OR DELETE ON score_sheets FOR EACH ROW EXECUTE FUNCTION score_sheets_immutable();

CREATE TABLE critiques (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  performance_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  visibility text NOT NULL CHECK (visibility IN ('private', 'contestant', 'public')),
  moderation_status text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'hidden')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (performance_id, judge_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (competition_id, performance_id) REFERENCES performances (competition_id, id),
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id)
);
CREATE TABLE critique_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  critique_id uuid NOT NULL,
  revision integer NOT NULL,
  body text NOT NULL,
  visibility text NOT NULL,
  moderation_status text NOT NULL,
  changed_by_account_id uuid NOT NULL REFERENCES accounts(id),
  change_reason text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, critique_id) REFERENCES critiques (organization_id, id),
  UNIQUE (critique_id, revision)
);
CREATE TABLE critique_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  critique_id uuid NOT NULL,
  appellant_account_id uuid NOT NULL REFERENCES accounts(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'dismissed')),
  resolution text,
  resolved_by_account_id uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (organization_id, critique_id) REFERENCES critiques (organization_id, id)
);
CREATE UNIQUE INDEX critique_appeals_one_open ON critique_appeals (critique_id) WHERE status = 'open';
CREATE FUNCTION critique_revisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'critique revisions are append-only';
END;
$$;
CREATE TRIGGER critique_revisions_no_mutation BEFORE UPDATE OR DELETE ON critique_revisions FOR EACH ROW EXECUTE FUNCTION critique_revisions_append_only();
