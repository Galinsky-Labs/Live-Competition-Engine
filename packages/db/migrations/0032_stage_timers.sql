-- LC-24 server-authoritative timers. State is derived by replaying stage_timer_commands.
CREATE TABLE stage_timers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  performance_id uuid,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 1000 AND 21600000),
  max_extension_ms integer NOT NULL CHECK (max_extension_ms BETWEEN 0 AND 3600000),
  head_sequence integer NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, competition_id, performance_id) REFERENCES performances (organization_id, competition_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX stage_timers_one_per_performance ON stage_timers (organization_id, performance_id) WHERE performance_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX stage_timers_competition_idx ON stage_timers (organization_id, competition_id);
--> statement-breakpoint
-- Append-only command log. (timer_id, sequence) primary key makes concurrent appends fail
-- instead of forking the log; writers also lock the timer row.
CREATE TABLE stage_timer_commands (
  organization_id uuid NOT NULL,
  timer_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  command text NOT NULL CHECK (command IN ('start', 'pause', 'resume', 'extend', 'reset')),
  amount_ms integer CHECK (amount_ms IS NULL OR amount_ms BETWEEN 1000 AND 600000),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 1000 AND 21600000),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  issued_at_ms bigint NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (timer_id, sequence),
  UNIQUE (timer_id, idempotency_key),
  FOREIGN KEY (organization_id, timer_id) REFERENCES stage_timers (organization_id, id)
);
--> statement-breakpoint
CREATE FUNCTION stage_timer_commands_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stage_timer_commands is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stage_timer_commands_no_update BEFORE UPDATE OR DELETE ON stage_timer_commands
  FOR EACH ROW EXECUTE FUNCTION stage_timer_commands_immutable();
