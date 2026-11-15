-- LC-18 producer selection: versioned round lineups and judge panels.
CREATE UNIQUE INDEX IF NOT EXISTS performances_org_id_uniq ON performances (organization_id, id);
--> statement-breakpoint
CREATE TABLE round_lineups (
  round_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by_account_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, round_id) REFERENCES rounds (organization_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
--> statement-breakpoint
CREATE TABLE round_lineup_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  round_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array'),
  actor_account_id uuid NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, revision),
  FOREIGN KEY (organization_id, round_id) REFERENCES rounds (organization_id, id)
);
--> statement-breakpoint
CREATE TRIGGER round_lineup_history_append_only BEFORE UPDATE OR DELETE ON round_lineup_history
  FOR EACH ROW EXECUTE FUNCTION lce_append_only_guard();
--> statement-breakpoint
CREATE TABLE round_judge_panels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  panel_role text NOT NULL DEFAULT 'panelist' CHECK (panel_role IN ('panelist','head')),
  assigned_by_account_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_by_account_id uuid,
  removed_at timestamptz,
  CHECK ((removed_at IS NULL) = (removed_by_account_id IS NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, round_id) REFERENCES rounds (organization_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id),
  FOREIGN KEY (competition_id, judge_id) REFERENCES competition_judges (competition_id, judge_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX round_judge_panels_active_uniq ON round_judge_panels (round_id, judge_id) WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX round_judge_panels_one_head_uniq ON round_judge_panels (round_id) WHERE removed_at IS NULL AND panel_role = 'head';
--> statement-breakpoint
CREATE INDEX round_judge_panels_judge_idx ON round_judge_panels (organization_id, judge_id) WHERE removed_at IS NULL;
--> statement-breakpoint
-- Per-competition judge lifecycle (LC-19 writes it; panels exclude suspended/removed judges).
CREATE TABLE competition_judge_states (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','verified','suspended','removed')),
  verified_at timestamptz,
  verified_by_account_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_account_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, judge_id),
  CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND verified_by_account_id IS NOT NULL)),
  FOREIGN KEY (competition_id, judge_id) REFERENCES competition_judges (competition_id, judge_id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
--> statement-breakpoint
-- Judges are linked to member accounts when they accept an invitation (LC-19).
ALTER TABLE judges ADD COLUMN IF NOT EXISTS account_id uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'judges_account_membership_fk') THEN
    ALTER TABLE judges ADD CONSTRAINT judges_account_membership_fk
      FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships (organization_id, account_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS judges_org_account_uniq ON judges (organization_id, account_id) WHERE account_id IS NOT NULL;
