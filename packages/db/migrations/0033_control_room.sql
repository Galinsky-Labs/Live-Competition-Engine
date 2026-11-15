-- LC-25 producer control room. One show-control row per competition serializes all
-- run-of-show mutations (row lock) and carries the broadcast sequence used by LC-26 overlays.
CREATE TABLE show_controls (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'standby' CHECK (state IN ('standby', 'running', 'paused', 'ended')),
  pause_reason text CHECK (pause_reason IS NULL OR length(pause_reason) BETWEEN 1 AND 200),
  current_performance_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  broadcast_sequence bigint NOT NULL DEFAULT 1 CHECK (broadcast_sequence > 0),
  updated_by_account_id uuid REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, competition_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, competition_id, current_performance_id) REFERENCES performances (organization_id, competition_id, id),
  CHECK ((state = 'paused') = (pause_reason IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rounds_org_comp_id_uniq ON rounds (organization_id, competition_id, id);
--> statement-breakpoint
-- Results visibility per round, toggled by the control room. Public scoreboards read only
-- results of rounds with results_published = true.
CREATE TABLE round_publications (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL,
  results_published boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, round_id),
  FOREIGN KEY (organization_id, competition_id, round_id) REFERENCES rounds (organization_id, competition_id, id)
);
