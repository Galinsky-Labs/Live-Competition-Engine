-- LC-15 generic stage builder. A stage is the configuration of exactly one round:
-- rounds keep label/ordinal/status (and results keep pointing at rounds), stages add
-- kind, timing and the advancement contract. Advancement decisions are append-only.
CREATE TABLE stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  round_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('audition', 'qualifier', 'heat', 'semifinal', 'final', 'custom')),
  custom_label text CHECK (length(btrim(custom_label)) > 0 AND length(custom_label) <= 60),
  timed boolean NOT NULL,
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 604800),
  advancement jsonb CHECK (advancement IS NULL OR jsonb_typeof(advancement) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (competition_id, id),
  CHECK ((kind = 'custom') = (custom_label IS NOT NULL)),
  CHECK (timed = (duration_seconds IS NOT NULL)),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, round_id) REFERENCES rounds (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, round_id) REFERENCES rounds (competition_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX stages_competition_idx ON stages (organization_id, competition_id);
--> statement-breakpoint
CREATE TABLE stage_advancements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id uuid NOT NULL,
  stage_id uuid NOT NULL UNIQUE,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  contract jsonb NOT NULL,
  standings jsonb NOT NULL,
  advancing jsonb NOT NULL CHECK (jsonb_typeof(advancing) = 'array'),
  eliminated jsonb NOT NULL CHECK (jsonb_typeof(eliminated) = 'array'),
  tie_broken boolean NOT NULL,
  tied_at_cut jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_by_account_id uuid NOT NULL REFERENCES accounts(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, stage_id) REFERENCES stages (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (competition_id, stage_id) REFERENCES stages (competition_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE FUNCTION stage_advancements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stage_advancements is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stage_advancements_no_update BEFORE UPDATE ON stage_advancements
  FOR EACH ROW EXECUTE FUNCTION stage_advancements_immutable();
