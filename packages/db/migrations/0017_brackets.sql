-- LC-16 optional head-to-head model: generic teams (groups/crews), matches between
-- two or more sides, and seeded single-elimination brackets. Nothing else references
-- these tables; events work without them.
CREATE UNIQUE INDEX IF NOT EXISTS entries_competition_scope_lc16_uniq ON entries (competition_id, id);
--> statement-breakpoint
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (competition_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX teams_competition_name_uniq ON teams (competition_id, lower(name));
--> statement-breakpoint
CREATE TABLE team_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  team_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, participant_id),
  -- A participant belongs to at most one team per event.
  UNIQUE (competition_id, participant_id),
  FOREIGN KEY (competition_id, team_id) REFERENCES teams (competition_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, team_id) REFERENCES teams (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, participant_id) REFERENCES participants (organization_id, id)
);
--> statement-breakpoint
CREATE TABLE brackets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  stage_id uuid,
  format text NOT NULL CHECK (format IN ('single_elimination')),
  side_kind text NOT NULL CHECK (side_kind IN ('entry', 'team')),
  size integer NOT NULL CHECK (size BETWEEN 2 AND 256),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (competition_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, stage_id) REFERENCES stages (competition_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX brackets_one_per_stage ON brackets (stage_id) WHERE stage_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  bracket_id uuid,
  round_number integer CHECK (round_number > 0),
  position integer CHECK (position >= 0),
  expected_sides integer NOT NULL DEFAULT 2 CHECK (expected_sides BETWEEN 2 AND 64),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'decided', 'void')),
  is_bye boolean NOT NULL DEFAULT false,
  winner_slot integer,
  next_match_id uuid,
  next_slot integer CHECK (next_slot IN (0, 1)),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  decided_by_account_id uuid REFERENCES accounts(id),
  decided_at timestamptz,
  void_reason text CHECK (length(void_reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (competition_id, id),
  UNIQUE (bracket_id, round_number, position),
  CHECK ((status = 'decided') = (winner_slot IS NOT NULL)),
  CHECK ((status = 'void') = (void_reason IS NOT NULL)),
  CHECK ((bracket_id IS NULL) = (round_number IS NULL) AND (bracket_id IS NULL) = (position IS NULL)),
  CHECK ((next_match_id IS NULL) = (next_slot IS NULL)),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, bracket_id) REFERENCES brackets (competition_id, id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, next_match_id) REFERENCES matches (competition_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX matches_bracket_idx ON matches (bracket_id, round_number, position);
--> statement-breakpoint
CREATE TABLE match_sides (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  match_id uuid NOT NULL,
  slot integer NOT NULL CHECK (slot BETWEEN 0 AND 63),
  entry_id uuid,
  team_id uuid,
  seed integer CHECK (seed > 0),
  PRIMARY KEY (match_id, slot),
  CHECK ((entry_id IS NULL) <> (team_id IS NULL)),
  FOREIGN KEY (competition_id, match_id) REFERENCES matches (competition_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, match_id) REFERENCES matches (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id),
  FOREIGN KEY (competition_id, team_id) REFERENCES teams (competition_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX match_sides_entry_once ON match_sides (match_id, entry_id) WHERE entry_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX match_sides_team_once ON match_sides (match_id, team_id) WHERE team_id IS NOT NULL;
