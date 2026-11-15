-- LC-22 streaming foundation: provider-backed live streams linked to a competition.
-- Stream keys are never stored in plaintext: only a SHA-256 hash and the last 4 characters.
CREATE TYPE stream_status AS ENUM ('idle', 'active', 'disconnected', 'ended', 'failed');
--> statement-breakpoint
CREATE TABLE streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('mux', 'fake')),
  provider_stream_id text NOT NULL CHECK (length(provider_stream_id) BETWEEN 1 AND 200),
  ingest_url text NOT NULL CHECK (length(ingest_url) BETWEEN 1 AND 500),
  stream_key_hash char(64) NOT NULL,
  stream_key_last4 text NOT NULL CHECK (length(stream_key_last4) <= 4),
  playback_id text CHECK (playback_id IS NULL OR length(playback_id) BETWEEN 1 AND 200),
  recording_asset_id text CHECK (recording_asset_id IS NULL OR length(recording_asset_id) BETWEEN 1 AND 200),
  status stream_status NOT NULL DEFAULT 'idle',
  failure_reason text CHECK (failure_reason IS NULL OR length(failure_reason) <= 200),
  published boolean NOT NULL DEFAULT false,
  previous_stream_id uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_stream_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, previous_stream_id) REFERENCES streams (organization_id, id)
);
--> statement-breakpoint
-- At most one non-terminal stream per competition; recovery re-creates after the old one is terminal.
CREATE UNIQUE INDEX streams_one_open_per_competition ON streams (organization_id, competition_id)
  WHERE status NOT IN ('ended', 'failed');
--> statement-breakpoint
CREATE INDEX streams_competition_idx ON streams (organization_id, competition_id, created_at DESC);
--> statement-breakpoint
-- Provider webhook inbox. Unique provider event id makes processing idempotent.
-- organization_id is resolved from the stream and is NULL for events about unknown streams.
CREATE TABLE stream_provider_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('mux', 'fake')),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  provider_stream_id text CHECK (provider_stream_id IS NULL OR length(provider_stream_id) <= 200),
  organization_id uuid,
  stream_id uuid,
  outcome text NOT NULL CHECK (length(outcome) <= 100),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
