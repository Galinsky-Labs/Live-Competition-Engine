-- LC-34: creator/promoter membership plans and recurring subscriptions with recorded consent.
CREATE TABLE membership_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  creator_type text NOT NULL CHECK (creator_type IN ('tenant', 'participant', 'account')),
  creator_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  terms_version text NOT NULL CHECK (terms_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK ((creator_type = 'tenant') = (creator_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX membership_plans_creator_idx ON membership_plans (organization_id, creator_type, creator_id, status);
--> statement-breakpoint
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  plan_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'incomplete' CHECK (status IN ('incomplete', 'active', 'past_due', 'cancelled', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- Consent evidence: exactly what the subscriber agreed to, and when.
  consent_terms_version text NOT NULL,
  consent_price_minor bigint NOT NULL,
  consent_currency text NOT NULL,
  consent_interval text NOT NULL,
  consent_at timestamptz NOT NULL,
  provider text NOT NULL CHECK (provider IN ('stripe', 'fake')),
  provider_checkout_reference text CHECK (length(provider_checkout_reference) <= 255),
  provider_subscription_id text CHECK (length(provider_subscription_id) <= 255),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, account_id, idempotency_key),
  CHECK ((status IN ('cancelled', 'expired')) = (ended_at IS NOT NULL)),
  CHECK (current_period_end IS NULL OR current_period_end > current_period_start),
  FOREIGN KEY (organization_id, plan_id) REFERENCES membership_plans(organization_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX subscriptions_provider_id_idx ON subscriptions (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
--> statement-breakpoint
-- One live subscription per subscriber per plan.
CREATE UNIQUE INDEX subscriptions_live_idx ON subscriptions (organization_id, plan_id, account_id)
  WHERE status IN ('incomplete', 'active', 'past_due');
--> statement-breakpoint
CREATE TABLE subscription_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, subscription_id) REFERENCES subscriptions(organization_id, id)
);
--> statement-breakpoint
CREATE TRIGGER subscription_history_append_only BEFORE UPDATE OR DELETE ON subscription_history
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
