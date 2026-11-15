-- LC-26 broadcast presentation: producer-set on-air text (lower thirds and captions).
CREATE TABLE broadcast_captions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('lower_third', 'caption')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 120),
  subtitle text CHECK (subtitle IS NULL OR length(subtitle) BETWEEN 1 AND 120),
  active boolean NOT NULL DEFAULT true,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_by_account_id uuid REFERENCES accounts(id),
  cleared_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  CHECK (active = (cleared_at IS NULL))
);
--> statement-breakpoint
-- At most one on-air item per kind per competition.
CREATE UNIQUE INDEX broadcast_captions_one_active ON broadcast_captions (organization_id, competition_id, kind) WHERE active;
