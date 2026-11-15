-- LC-29 voting integrity: audited ballot voids and stored anomaly flags.
CREATE TABLE vote_ballot_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  window_id uuid NOT NULL,
  ballot_id uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  voided_by_account_id uuid NOT NULL REFERENCES accounts(id),
  snapshot_version integer CHECK (snapshot_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, window_id, ballot_id) REFERENCES vote_ballots(organization_id, window_id, id)
);
--> statement-breakpoint
CREATE FUNCTION vote_ballot_voids_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vote_ballot_voids is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vote_ballot_voids_no_update BEFORE UPDATE ON vote_ballot_voids
  FOR EACH ROW EXECUTE FUNCTION vote_ballot_voids_immutable();
--> statement-breakpoint
CREATE TABLE vote_anomaly_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  window_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('burst','new_account_ratio','timing_cluster')),
  fingerprint text NOT NULL CHECK (length(fingerprint) BETWEEN 1 AND 200),
  details jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_account_id uuid REFERENCES accounts(id),
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 500),
  CHECK ((status = 'open') = (reviewed_at IS NULL)),
  UNIQUE (window_id, kind, fingerprint),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, window_id) REFERENCES vote_windows(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX vote_anomaly_flags_window_idx ON vote_anomaly_flags (organization_id, window_id, status);
