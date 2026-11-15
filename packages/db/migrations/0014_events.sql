-- LC-13 event creation: competitions are events. Adds public identity, scheduling,
-- location/stream, visibility, lifecycle timestamps and an optimistic revision.
ALTER TABLE competitions
  ADD COLUMN slug text CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  ADD COLUMN capacity integer CHECK (capacity BETWEEN 1 AND 1000000),
  ADD COLUMN venue_name text CHECK (length(venue_name) BETWEEN 1 AND 200),
  ADD COLUMN venue_address text CHECK (length(venue_address) BETWEEN 1 AND 500),
  ADD COLUMN stream_url text CHECK (stream_url ~ '^https://' AND length(stream_url) <= 2048),
  ADD COLUMN visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'members', 'private')),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN published_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text CHECK (length(cancel_reason) BETWEEN 1 AND 1000),
  ADD COLUMN created_by_account_id uuid REFERENCES accounts(id);
--> statement-breakpoint
-- Status/cancelled_at consistency is enforced by the event service (legacy rows and fixtures
-- may set status directly); reason and timestamp always travel together.
ALTER TABLE competitions ADD CONSTRAINT competitions_cancel_consistency CHECK (
  (cancelled_at IS NULL) = (cancel_reason IS NULL)
);
--> statement-breakpoint
ALTER TABLE competitions ADD CONSTRAINT competitions_time_order CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at) NOT VALID;
--> statement-breakpoint
CREATE UNIQUE INDEX competitions_org_slug_uniq ON competitions (organization_id, slug) WHERE slug IS NOT NULL;
--> statement-breakpoint
CREATE INDEX competitions_public_listing_idx ON competitions (organization_id, visibility, status, starts_at);
--> statement-breakpoint
-- Append-only lifecycle history (one row per transition).
CREATE TABLE competition_status_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  from_status competition_status NOT NULL,
  to_status competition_status NOT NULL,
  reason text CHECK (length(reason) <= 1000),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  revision integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX competition_status_history_idx ON competition_status_history (organization_id, competition_id, id);
--> statement-breakpoint
CREATE FUNCTION competition_status_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'competition_status_history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER competition_status_history_no_update BEFORE UPDATE ON competition_status_history
  FOR EACH ROW EXECUTE FUNCTION competition_status_history_immutable();
