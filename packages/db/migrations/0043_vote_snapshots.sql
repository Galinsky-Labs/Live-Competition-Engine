-- LC-28/29 immutable tally snapshots. Each window close (and each later void)
-- writes a NEW version; existing versions can never be updated.
CREATE TABLE vote_tally_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  window_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  reason text NOT NULL CHECK (reason IN ('close','void')),
  tally_method text NOT NULL CHECK (tally_method IN ('plurality','approval','points','borda','irv')),
  merkle_root text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  ballot_count integer NOT NULL CHECK (ballot_count >= 0),
  total_weight integer NOT NULL CHECK (total_weight >= 0),
  -- Sorted commitments (the Merkle leaves) so inclusion proofs can be served for any version.
  commitments jsonb NOT NULL,
  tally jsonb NOT NULL,
  created_by_account_id uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (window_id, version),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, window_id) REFERENCES vote_windows(organization_id, id)
);
--> statement-breakpoint
CREATE FUNCTION vote_tally_snapshots_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vote_tally_snapshots versions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vote_tally_snapshots_no_update BEFORE UPDATE ON vote_tally_snapshots
  FOR EACH ROW EXECUTE FUNCTION vote_tally_snapshots_immutable();
