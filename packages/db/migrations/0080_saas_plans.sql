-- LC-49 SaaS plan management: versioned platform plans, tenant subscriptions,
-- append-only subscription change history and append-only usage metering.
CREATE TABLE saas_plans (
  id uuid PRIMARY KEY,
  plan_key text NOT NULL CHECK (plan_key ~ '^[a-z][a-z0-9_-]{1,39}$'),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  price_minor bigint NOT NULL CHECK (price_minor >= 0 AND price_minor <= 100000000000),
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
  features jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(features) = 'array'),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(limits) = 'object'),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  UNIQUE (plan_key, version),
  CHECK (status = 'draft' OR published_at IS NOT NULL),
  CHECK (status <> 'retired' OR retired_at IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX saas_plans_status_idx ON saas_plans (status, plan_key, version DESC);
--> statement-breakpoint
-- Commercial terms of a published plan version are immutable: change them by creating a new version.
CREATE FUNCTION saas_plans_freeze_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'published saas plan versions cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.plan_key IS DISTINCT FROM OLD.plan_key OR NEW.version IS DISTINCT FROM OLD.version OR
    NEW.currency IS DISTINCT FROM OLD.currency OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval OR
    NEW.price_minor IS DISTINCT FROM OLD.price_minor OR NEW.trial_days IS DISTINCT FROM OLD.trial_days OR
    NEW.features IS DISTINCT FROM OLD.features OR NEW.limits IS DISTINCT FROM OLD.limits
  ) THEN
    RAISE EXCEPTION 'published saas plan versions are immutable';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'retired saas plan versions cannot be republished';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER saas_plans_freeze BEFORE UPDATE OR DELETE ON saas_plans
  FOR EACH ROW EXECUTE FUNCTION saas_plans_freeze_published();
--> statement-breakpoint
CREATE TABLE tenant_subscriptions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES saas_plans(id),
  status text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  pending_plan_id uuid REFERENCES saas_plans(id),
  pending_change_at timestamptz,
  pending_overage_flagged boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  UNIQUE (organization_id, id),
  CHECK (current_period_end > current_period_start),
  CHECK ((pending_plan_id IS NULL) = (pending_change_at IS NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'trialing' OR trial_ends_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX tenant_subscriptions_one_open ON tenant_subscriptions (organization_id)
  WHERE status <> 'cancelled';
--> statement-breakpoint
CREATE TABLE tenant_subscription_changes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('started', 'upgraded', 'downgrade_scheduled', 'downgrade_cancelled',
    'downgrade_applied', 'renewed', 'trial_ended', 'status_changed', 'cancelled')),
  from_plan_id uuid REFERENCES saas_plans(id),
  to_plan_id uuid REFERENCES saas_plans(id),
  from_status text,
  to_status text,
  currency char(3),
  charge_minor bigint NOT NULL DEFAULT 0,
  credit_minor bigint NOT NULL DEFAULT 0,
  net_minor bigint NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_account_id uuid,
  idempotency_key text CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, subscription_id) REFERENCES tenant_subscriptions(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, idempotency_key)
);
--> statement-breakpoint
CREATE INDEX tenant_subscription_changes_sub_idx ON tenant_subscription_changes (organization_id, subscription_id, created_at);
--> statement-breakpoint
CREATE TABLE usage_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_]{1,63}$'),
  quantity bigint NOT NULL CHECK (quantity <> 0 AND quantity BETWEEN -1000000000000000 AND 1000000000000000),
  occurred_at timestamptz NOT NULL,
  period_start date NOT NULL,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  CHECK (period_start = date_trunc('month', occurred_at AT TIME ZONE 'UTC')::date)
);
--> statement-breakpoint
CREATE INDEX usage_records_period_idx ON usage_records (organization_id, period_start, metric);
--> statement-breakpoint
CREATE FUNCTION saas_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usage_records_no_update BEFORE UPDATE ON usage_records
  FOR EACH ROW EXECUTE FUNCTION saas_append_only();
--> statement-breakpoint
CREATE TRIGGER tenant_subscription_changes_no_update BEFORE UPDATE ON tenant_subscription_changes
  FOR EACH ROW EXECUTE FUNCTION saas_append_only();
