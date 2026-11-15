-- LC-21 critiques and feedback: private/public critiques, moderation, appeals with append-only trails.
CREATE TABLE critiques (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL,
  performance_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  author_account_id uuid NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private','public')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','delivered','pending_moderation','published','rejected','withdrawn','retracted')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  submitted_at timestamptz,
  moderated_by_account_id uuid,
  moderated_at timestamptz,
  moderation_reason text CHECK (moderation_reason IS NULL OR length(moderation_reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('delivered','published') OR (status = 'delivered') = (visibility = 'private')),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id),
  FOREIGN KEY (organization_id, performance_id) REFERENCES performances (organization_id, id),
  FOREIGN KEY (organization_id, entry_id) REFERENCES entries (organization_id, id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id),
  FOREIGN KEY (organization_id, author_account_id) REFERENCES organization_memberships (organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX critiques_one_current_uniq ON critiques (performance_id, judge_id) WHERE status NOT IN ('withdrawn','retracted');
--> statement-breakpoint
CREATE INDEX critiques_queue_idx ON critiques (organization_id, competition_id, status);
--> statement-breakpoint
CREATE INDEX critiques_entry_idx ON critiques (organization_id, entry_id, status);
--> statement-breakpoint
CREATE TABLE critique_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  critique_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('judge','producer','entrant')),
  actor_account_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, critique_id) REFERENCES critiques (organization_id, id)
);
--> statement-breakpoint
CREATE TRIGGER critique_events_append_only BEFORE UPDATE OR DELETE ON critique_events
  FOR EACH ROW EXECUTE FUNCTION lce_append_only_guard();
--> statement-breakpoint
CREATE TABLE critique_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  critique_id uuid NOT NULL,
  requester_account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('appeal','correction')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','upheld','dismissed','withdrawn')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  resolution_reason text CHECK (resolution_reason IS NULL OR length(resolution_reason) BETWEEN 1 AND 1000),
  resolved_by_account_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('upheld','dismissed')) = (resolved_at IS NOT NULL AND resolution_reason IS NOT NULL AND resolved_by_account_id IS NOT NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, critique_id) REFERENCES critiques (organization_id, id),
  FOREIGN KEY (organization_id, requester_account_id) REFERENCES organization_memberships (organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX critique_appeals_one_open_uniq ON critique_appeals (critique_id) WHERE status IN ('open','under_review');
--> statement-breakpoint
CREATE TABLE critique_appeal_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  appeal_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('entrant','producer')),
  actor_account_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, appeal_id) REFERENCES critique_appeals (organization_id, id)
);
--> statement-breakpoint
CREATE TRIGGER critique_appeal_events_append_only BEFORE UPDATE OR DELETE ON critique_appeal_events
  FOR EACH ROW EXECUTE FUNCTION lce_append_only_guard();
