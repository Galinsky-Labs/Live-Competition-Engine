-- LC-50 tenant signup and onboarding.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
--> statement-breakpoint
-- Single-use email verification tokens; only a SHA-256 hash of the token is stored.
CREATE TABLE account_email_verifications (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  superseded_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);
--> statement-breakpoint
CREATE INDEX account_email_verifications_account_idx ON account_email_verifications (account_id, created_at DESC);
--> statement-breakpoint
-- Signup rate limiting. Only a keyed hash of the client IP is stored, never the address.
CREATE TABLE signup_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash char(64) NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX signup_attempts_ip_time_idx ON signup_attempts (ip_hash, attempted_at DESC);
--> statement-breakpoint
CREATE TABLE tenant_onboarding (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  skipped_steps text[] NOT NULL DEFAULT '{}'
    CHECK (skipped_steps <@ ARRAY['branding_set','custom_domain_claimed','members_invited','payment_setup']::text[]),
  first_event_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, first_event_id) REFERENCES competitions(organization_id, id)
);
