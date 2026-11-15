-- LC-28 voting engine: windows, options and ballots.
CREATE UNIQUE INDEX IF NOT EXISTS rounds_org_competition_id_uniq ON rounds (organization_id, competition_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS entries_org_competition_id_uniq ON entries (organization_id, competition_id, id);
--> statement-breakpoint
CREATE TABLE vote_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed','cancelled')),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  ballot_type text NOT NULL CHECK (ballot_type IN ('single','approval','distributed','ranked')),
  tally_method text NOT NULL CHECK (tally_method IN ('plurality','approval','points','borda','irv')),
  eligibility text NOT NULL CHECK (eligibility IN ('any_member','entitled','joined_before_open')),
  exclude_participants boolean NOT NULL,
  weighting text NOT NULL CHECK (weighting IN ('equal','verified')),
  verified_weight integer NOT NULL CHECK (verified_weight BETWEEN 1 AND 10),
  max_points integer CHECK (max_points BETWEEN 1 AND 1000),
  max_selections integer CHECK (max_selections BETWEEN 1 AND 50),
  result_visibility text NOT NULL CHECK (result_visibility IN ('hidden_until_close','live','never_public')),
  allow_change boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by_account_id uuid REFERENCES accounts(id),
  CHECK (closes_at > opens_at),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (
    (ballot_type = 'single' AND tally_method = 'plurality' AND max_points IS NULL AND max_selections IS NULL) OR
    (ballot_type = 'approval' AND tally_method = 'approval' AND max_points IS NULL AND max_selections IS NOT NULL) OR
    (ballot_type = 'distributed' AND tally_method = 'points' AND max_points IS NOT NULL AND max_selections IS NULL) OR
    (ballot_type = 'ranked' AND tally_method IN ('borda','irv') AND max_points IS NULL AND max_selections IS NOT NULL)
  ),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, competition_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id),
  FOREIGN KEY (organization_id, competition_id, round_id) REFERENCES rounds(organization_id, competition_id, id)
);
--> statement-breakpoint
CREATE INDEX vote_windows_competition_idx ON vote_windows (organization_id, competition_id, opens_at);
--> statement-breakpoint
CREATE TABLE vote_window_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  window_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  entry_id uuid NOT NULL,
  performance_id uuid,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  UNIQUE (window_id, ordinal),
  UNIQUE NULLS NOT DISTINCT (window_id, entry_id, performance_id),
  UNIQUE (organization_id, window_id, id),
  FOREIGN KEY (organization_id, competition_id, window_id) REFERENCES vote_windows(organization_id, competition_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, competition_id, entry_id) REFERENCES entries(organization_id, competition_id, id),
  FOREIGN KEY (organization_id, competition_id, performance_id) REFERENCES performances(organization_id, competition_id, id)
);
--> statement-breakpoint
-- Voter privacy: a ballot stores only the account id (for one-per-account rules)
-- and a random pseudonymous receipt; no other identity data is collected.
CREATE TABLE vote_ballots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  window_id uuid NOT NULL,
  account_id uuid NOT NULL,
  receipt text NOT NULL UNIQUE CHECK (receipt ~ '^[A-Za-z0-9_-]{22}$'),
  choice jsonb NOT NULL,
  weight integer NOT NULL CHECK (weight BETWEEN 1 AND 10),
  salt text NOT NULL CHECK (salt ~ '^[0-9a-f]{64}$'),
  commitment text NOT NULL CHECK (commitment ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','voided')),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  voided_at timestamptz,
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, window_id, id),
  UNIQUE (organization_id, window_id, account_id, idempotency_key),
  FOREIGN KEY (organization_id, window_id) REFERENCES vote_windows(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX vote_ballots_one_active_idx ON vote_ballots (window_id, account_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX vote_ballots_window_idx ON vote_ballots (organization_id, window_id, status, created_at);
