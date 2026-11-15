-- LC-22 stream lifecycle records and LC-23 backstage / green room.
CREATE TABLE event_streams (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('external_embed', 'mux')),
  external_id text,
  embed_url text,
  playback_url text,
  ingest_url text,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'live', 'ended', 'failed')),
  failure_reason text,
  recording_url text,
  revision integer NOT NULL DEFAULT 1,
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);

CREATE TABLE backstage_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  author_role text NOT NULL CHECK (author_role IN ('producer', 'judge', 'performer')),
  audience text NOT NULL CHECK (audience IN ('crew', 'judges', 'performers', 'everyone_backstage')),
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'cue')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id)
);
CREATE INDEX backstage_messages_event_idx ON backstage_messages (competition_id, id DESC);

CREATE TABLE performer_readiness (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('not_ready', 'ready', 'technical_issue', 'on_stage')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (competition_id, entry_id),
  FOREIGN KEY (competition_id, entry_id) REFERENCES entries (competition_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
