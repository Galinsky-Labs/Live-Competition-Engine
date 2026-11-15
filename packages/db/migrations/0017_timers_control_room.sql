-- LC-24 server-authoritative timers, LC-25 control room state, LC-26 broadcast presentation.
CREATE TABLE timer_events (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  timer_key text NOT NULL CHECK (timer_key ~ '^(stage|performance):[0-9a-f-]{36}$'),
  seq integer NOT NULL CHECK (seq > 0),
  command jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  PRIMARY KEY (competition_id, timer_key, seq),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);
CREATE FUNCTION timer_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'timer events are append-only';
END;
$$;
CREATE TRIGGER timer_events_no_mutation BEFORE UPDATE OR DELETE ON timer_events FOR EACH ROW EXECUTE FUNCTION timer_events_append_only();

CREATE TABLE event_live_state (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid PRIMARY KEY,
  caption text CHECK (caption IS NULL OR length(caption) <= 500),
  overlay_message text CHECK (overlay_message IS NULL OR length(overlay_message) <= 200),
  show_scoreboard boolean NOT NULL DEFAULT false,
  safety_stop_reason text,
  revision integer NOT NULL DEFAULT 1,
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id)
);

-- At most one live performance per stage.
CREATE UNIQUE INDEX performances_one_live_per_round ON performances (round_id) WHERE status = 'live';
