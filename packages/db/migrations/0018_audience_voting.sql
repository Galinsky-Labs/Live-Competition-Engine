-- LC-27 audience interaction, LC-28 voting engine, LC-29 voting integrity.
CREATE TABLE audience_consents (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  consent_version text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, account_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);

CREATE TABLE audience_reactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  performance_id uuid,
  account_id uuid NOT NULL REFERENCES accounts(id),
  reaction text NOT NULL CHECK (reaction ~ '^[a-z_]{1,24}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, performance_id) REFERENCES performances (competition_id, id)
);
CREATE INDEX audience_reactions_rate_idx ON audience_reactions (account_id, created_at DESC);
CREATE INDEX audience_reactions_perf_idx ON audience_reactions (competition_id, performance_id);

CREATE TABLE audience_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('chat', 'question')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')),
  moderated_by_account_id uuid REFERENCES accounts(id),
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
CREATE INDEX audience_messages_event_idx ON audience_messages (competition_id, status, id DESC);

CREATE TABLE audience_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  options jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
CREATE TABLE audience_poll_answers (
  poll_id uuid NOT NULL REFERENCES audience_polls(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  option_index integer NOT NULL CHECK (option_index >= 0),
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, account_id)
);

CREATE TABLE vote_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid,
  matchup_id uuid REFERENCES matchups(id),
  title text NOT NULL,
  options uuid[] NOT NULL CHECK (cardinality(options) >= 2),
  eligibility text NOT NULL CHECK (eligibility IN ('any_account', 'tenant_members', 'entitled')),
  max_votes_per_voter integer NOT NULL CHECK (max_votes_per_voter > 0),
  max_votes_per_ip integer CHECK (max_votes_per_ip IS NULL OR max_votes_per_ip > 0),
  member_weight numeric(5, 2) NOT NULL DEFAULT 1,
  visibility text NOT NULL CHECK (visibility IN ('live', 'after_close', 'hidden')),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'open', 'closed')),
  opens_at timestamptz,
  closes_at timestamptz,
  secret char(64) NOT NULL,
  closed_digest char(64),
  revision integer NOT NULL DEFAULT 1,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id)
);

CREATE TABLE votes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_id uuid NOT NULL REFERENCES vote_windows(id),
  voter_hash char(64) NOT NULL,
  entry_id uuid NOT NULL,
  weight numeric(5, 2) NOT NULL CHECK (weight > 0),
  ip_hash char(64),
  new_account boolean NOT NULL DEFAULT false,
  cast_at timestamptz NOT NULL DEFAULT now(),
  prev_hash char(64) NOT NULL,
  row_hash char(64) NOT NULL UNIQUE,
  UNIQUE (window_id, voter_hash, entry_id),
  UNIQUE (window_id, prev_hash)
);
CREATE INDEX votes_window_idx ON votes (window_id, id);
CREATE TABLE vote_voids (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_id uuid NOT NULL REFERENCES vote_windows(id),
  vote_id bigint NOT NULL REFERENCES votes(id) UNIQUE,
  reason text NOT NULL CHECK (length(reason) >= 3),
  voided_by_account_id uuid NOT NULL REFERENCES accounts(id),
  voided_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION votes_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'votes are append-only';
END;
$$;
CREATE TRIGGER votes_no_mutation BEFORE UPDATE OR DELETE ON votes FOR EACH ROW EXECUTE FUNCTION votes_append_only();
CREATE TRIGGER vote_voids_no_mutation BEFORE UPDATE OR DELETE ON vote_voids FOR EACH ROW EXECUTE FUNCTION votes_append_only();
