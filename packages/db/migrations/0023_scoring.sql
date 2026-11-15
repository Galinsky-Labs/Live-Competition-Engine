-- LC-20 configurable scoring: versioned rubrics, immutable submitted score sheets, approved corrections.
CREATE TABLE scoring_rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_by_account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  activated_by_account_id uuid,
  CHECK (status = 'draft' OR (activated_at IS NOT NULL AND activated_by_account_id IS NOT NULL)),
  UNIQUE (organization_id, id),
  UNIQUE (competition_id, version),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, created_by_account_id) REFERENCES organization_memberships (organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX scoring_rubrics_one_active_uniq ON scoring_rubrics (competition_id) WHERE status = 'active';
--> statement-breakpoint
CREATE FUNCTION scoring_rubrics_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'scoring rubric % is immutable', OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.version <> OLD.version OR NEW.competition_id <> OLD.competition_id THEN
    RAISE EXCEPTION 'scoring rubric % is immutable', OLD.id;
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status IN ('draft','active')) OR (OLD.status = 'active' AND NEW.status IN ('active','retired'))
      OR (OLD.status = 'retired' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'invalid rubric status change % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER scoring_rubrics_immutable BEFORE UPDATE OR DELETE ON scoring_rubrics
  FOR EACH ROW EXECUTE FUNCTION scoring_rubrics_guard();
--> statement-breakpoint
CREATE TABLE score_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL,
  performance_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  rubric_id uuid NOT NULL,
  score_values jsonb NOT NULL CHECK (jsonb_typeof(score_values) = 'object'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','superseded')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  author_account_id uuid NOT NULL,
  submitted_at timestamptz,
  supersedes_sheet_id uuid,
  correction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'draft') = (submitted_at IS NULL)),
  CHECK ((supersedes_sheet_id IS NULL) = (correction_id IS NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id),
  FOREIGN KEY (organization_id, performance_id) REFERENCES performances (organization_id, id),
  FOREIGN KEY (organization_id, entry_id) REFERENCES entries (organization_id, id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id),
  FOREIGN KEY (competition_id, judge_id) REFERENCES competition_judges (competition_id, judge_id),
  FOREIGN KEY (organization_id, rubric_id) REFERENCES scoring_rubrics (organization_id, id),
  FOREIGN KEY (organization_id, supersedes_sheet_id) REFERENCES score_sheets (organization_id, id),
  FOREIGN KEY (organization_id, author_account_id) REFERENCES organization_memberships (organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX score_sheets_one_current_uniq ON score_sheets (performance_id, judge_id) WHERE status IN ('draft','submitted');
--> statement-breakpoint
CREATE INDEX score_sheets_standings_idx ON score_sheets (organization_id, competition_id, rubric_id, status, round_id);
--> statement-breakpoint
-- Submitted sheets are immutable: the only permitted change is submitted -> superseded (by an approved correction).
CREATE FUNCTION score_sheets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'submitted score sheet % is immutable', OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'superseded' THEN RAISE EXCEPTION 'submitted score sheet % is immutable', OLD.id; END IF;
  IF OLD.status = 'submitted' AND (NEW.status <> 'superseded' OR NEW.score_values IS DISTINCT FROM OLD.score_values
      OR NEW.performance_id <> OLD.performance_id OR NEW.judge_id <> OLD.judge_id OR NEW.rubric_id <> OLD.rubric_id
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.author_account_id <> OLD.author_account_id) THEN
    RAISE EXCEPTION 'submitted score sheet % is immutable', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER score_sheets_immutable BEFORE UPDATE OR DELETE ON score_sheets
  FOR EACH ROW EXECUTE FUNCTION score_sheets_guard();
--> statement-breakpoint
CREATE TABLE score_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  sheet_id uuid NOT NULL,
  requested_by_account_id uuid NOT NULL,
  proposed_values jsonb NOT NULL CHECK (jsonb_typeof(proposed_values) = 'object'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  decided_by_account_id uuid,
  decided_at timestamptz,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 1000),
  replacement_sheet_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by_account_id IS NULL)),
  CHECK ((status = 'approved') = (replacement_sheet_id IS NOT NULL)),
  CHECK (decided_by_account_id IS NULL OR decided_by_account_id <> requested_by_account_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, sheet_id) REFERENCES score_sheets (organization_id, id),
  FOREIGN KEY (organization_id, replacement_sheet_id) REFERENCES score_sheets (organization_id, id),
  FOREIGN KEY (organization_id, requested_by_account_id) REFERENCES organization_memberships (organization_id, account_id),
  FOREIGN KEY (organization_id, decided_by_account_id) REFERENCES organization_memberships (organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX score_corrections_one_pending_uniq ON score_corrections (sheet_id) WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE score_sheets ADD CONSTRAINT score_sheets_correction_fk
  FOREIGN KEY (organization_id, correction_id) REFERENCES score_corrections (organization_id, id);
