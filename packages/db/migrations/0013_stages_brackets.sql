-- LC-15 generic stages and LC-16 optional head-to-head / bracket model.
CREATE UNIQUE INDEX entries_competition_id_uniq ON entries (competition_id, id);

ALTER TABLE participants
  ADD COLUMN kind text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual', 'group')),
  ADD COLUMN account_id uuid REFERENCES accounts(id);

CREATE TABLE participant_group_members (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  group_participant_id uuid NOT NULL,
  member_participant_id uuid NOT NULL,
  PRIMARY KEY (group_participant_id, member_participant_id),
  CHECK (group_participant_id <> member_participant_id),
  FOREIGN KEY (organization_id, group_participant_id) REFERENCES participants (organization_id, id),
  FOREIGN KEY (organization_id, member_participant_id) REFERENCES participants (organization_id, id)
);

ALTER TABLE rounds
  ADD COLUMN kind text NOT NULL DEFAULT 'round' CHECK (kind IN ('audition', 'qualifier', 'heat', 'round', 'semifinal', 'final', 'showcase', 'custom')),
  ADD COLUMN format text NOT NULL DEFAULT 'lineup' CHECK (format IN ('lineup', 'head_to_head', 'round_robin', 'group')),
  ADD COLUMN timed boolean NOT NULL DEFAULT false,
  ADD COLUMN duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  ADD COLUMN advancement jsonb NOT NULL DEFAULT '{"type":"none"}'::jsonb,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD CONSTRAINT rounds_timed_duration CHECK (NOT timed OR duration_seconds IS NOT NULL);

CREATE TABLE stage_entrants (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  seed integer CHECK (seed IS NULL OR seed > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'advanced', 'eliminated', 'withdrawn')),
  source_round_id uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, entry_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id),
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id)
);
CREATE UNIQUE INDEX stage_entrants_seed_uniq ON stage_entrants (round_id, seed) WHERE seed IS NOT NULL;

CREATE TABLE matchups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL,
  bracket_round integer NOT NULL CHECK (bracket_round > 0),
  slot integer NOT NULL CHECK (slot >= 0),
  entry_a_id uuid,
  entry_b_id uuid,
  seed_a integer,
  seed_b integer,
  winner_entry_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'decided', 'bye')),
  next_matchup_id uuid REFERENCES matchups(id),
  next_side char(1) CHECK (next_side IN ('a', 'b')),
  decided_by_account_id uuid REFERENCES accounts(id),
  decided_at timestamptz,
  decision_reason text,
  revision integer NOT NULL DEFAULT 1,
  UNIQUE (round_id, bracket_round, slot),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id),
  FOREIGN KEY (competition_id, entry_a_id) REFERENCES entries (competition_id, id),
  FOREIGN KEY (competition_id, entry_b_id) REFERENCES entries (competition_id, id),
  FOREIGN KEY (competition_id, winner_entry_id) REFERENCES entries (competition_id, id),
  CHECK (entry_a_id IS NULL OR entry_b_id IS NULL OR entry_a_id <> entry_b_id),
  CHECK (winner_entry_id IS NULL OR winner_entry_id = entry_a_id OR winner_entry_id = entry_b_id),
  CHECK ((next_matchup_id IS NULL) = (next_side IS NULL))
);
CREATE INDEX matchups_round_idx ON matchups (round_id, bracket_round, slot);
