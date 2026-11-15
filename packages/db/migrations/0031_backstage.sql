-- LC-23 backstage and green room.
-- Composite keys let live-production tables reference rows of the SAME tenant AND competition.
CREATE UNIQUE INDEX IF NOT EXISTS performances_org_comp_id_uniq ON performances (organization_id, competition_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS entries_org_comp_id_uniq ON entries (organization_id, competition_id, id);
--> statement-breakpoint
-- Which tenant member speaks for an entry backstage (participants have no account link in the core schema).
CREATE TABLE backstage_entry_accounts (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  account_id uuid NOT NULL,
  linked_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, entry_id, account_id),
  FOREIGN KEY (organization_id, competition_id, entry_id) REFERENCES entries (organization_id, competition_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships (organization_id, account_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX backstage_entry_accounts_account_idx ON backstage_entry_accounts (organization_id, competition_id, account_id);
--> statement-breakpoint
-- Append-only backstage feed. seq is per competition, assigned under an advisory lock so a
-- poller reading `seq > since` never skips a row committed later with a lower seq.
CREATE TABLE backstage_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  kind text NOT NULL CHECK (kind IN ('checkin', 'cue', 'cue_ack', 'judge_message')),
  performance_id uuid,
  entry_id uuid,
  readiness text CHECK (readiness IS NULL OR readiness IN ('ready', 'not_ready', 'need_help')),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 500),
  ref_seq bigint,
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  author_role text NOT NULL CHECK (author_role IN ('producer', 'judge', 'performer')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (competition_id, seq),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, competition_id, performance_id) REFERENCES performances (organization_id, competition_id, id),
  FOREIGN KEY (organization_id, competition_id, entry_id) REFERENCES entries (organization_id, competition_id, id),
  CHECK (kind <> 'checkin' OR (readiness IS NOT NULL AND performance_id IS NOT NULL)),
  CHECK (kind <> 'cue' OR (entry_id IS NOT NULL AND length(body) BETWEEN 1 AND 280)),
  CHECK (kind <> 'cue_ack' OR ref_seq IS NOT NULL),
  CHECK (kind <> 'judge_message' OR length(body) >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX backstage_messages_one_ack ON backstage_messages (competition_id, ref_seq, author_account_id)
  WHERE kind = 'cue_ack';
--> statement-breakpoint
CREATE INDEX backstage_messages_author_time_idx ON backstage_messages (competition_id, author_account_id, created_at DESC);
--> statement-breakpoint
CREATE FUNCTION backstage_messages_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'backstage_messages is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER backstage_messages_no_update BEFORE UPDATE OR DELETE ON backstage_messages
  FOR EACH ROW EXECUTE FUNCTION backstage_messages_immutable();
