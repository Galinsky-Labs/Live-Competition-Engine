-- LC-31: double-entry ledger, payment orders, refunds, provider webhook events, reconciliation.
CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL CHECK (code ~ '^(platform_revenue|tenant_revenue|provider_clearing|sales_clearing|refunds|fees|payable:(promoter|performer|rights_owner|participant|account):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind text NOT NULL CHECK (kind IN ('asset', 'liability', 'revenue', 'expense')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code, currency)
);
--> statement-breakpoint
CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind text NOT NULL CHECK (kind IN ('payment', 'split', 'refund', 'reversal', 'adjustment')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  reverses_transaction_id uuid,
  source_type text NOT NULL CHECK (source_type ~ '^[a-z_]{1,40}$'),
  source_id uuid,
  memo text CHECK (memo IS NULL OR length(memo) <= 500),
  posted_by_account_id uuid REFERENCES accounts(id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, reverses_transaction_id) REFERENCES ledger_transactions(organization_id, id),
  CHECK ((kind = 'reversal') = (reverses_transaction_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX ledger_transactions_single_reversal_idx
  ON ledger_transactions (organization_id, reverses_transaction_id) WHERE reverses_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX ledger_transactions_source_idx ON ledger_transactions (organization_id, source_type, source_id);
--> statement-breakpoint
CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  ledger_account_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0 AND abs(amount_minor) <= 1000000000000),
  FOREIGN KEY (organization_id, transaction_id) REFERENCES ledger_transactions(organization_id, id),
  FOREIGN KEY (organization_id, ledger_account_id) REFERENCES ledger_accounts(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);
--> statement-breakpoint
CREATE INDEX ledger_entries_account_idx ON ledger_entries (organization_id, ledger_account_id, id);
--> statement-breakpoint
-- Deferred balance check: every transaction has >= 2 entries, one currency, and sums to zero.
CREATE FUNCTION ledger_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  total numeric;
  entry_count integer;
  mismatched integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN target := NEW.id; ELSE target := NEW.transaction_id; END IF;
  SELECT coalesce(sum(e.amount_minor), 0), count(e.id),
         count(e.id) FILTER (WHERE e.currency <> t.currency OR a.currency <> t.currency OR e.organization_id <> t.organization_id)
    INTO total, entry_count, mismatched
  FROM ledger_transactions t
  LEFT JOIN ledger_entries e ON e.transaction_id = t.id
  LEFT JOIN ledger_accounts a ON a.id = e.ledger_account_id
  WHERE t.id = target;
  IF entry_count < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger_unbalanced: transaction % (entries %, sum %)', target, entry_count, total USING ERRCODE = '23514';
  END IF;
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'ledger_currency_mismatch: transaction %', target USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();
--> statement-breakpoint
CREATE FUNCTION ledger_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_append_only: % on % is not allowed; post a reversal instead', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_append_only BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TABLE payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  event_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('ticket', 'ppv', 'entry_fee', 'subscription', 'tip', 'gift', 'content')),
  subject_id uuid,
  payee_type text CHECK (payee_type IN ('participant', 'account')),
  payee_id uuid,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 1000000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'requires_payment'
    CHECK (status IN ('requires_payment', 'processing', 'succeeded', 'failed', 'cancelled')),
  settlement_status text NOT NULL DEFAULT 'unsettled'
    CHECK (settlement_status IN ('unsettled', 'settled', 'partially_refunded', 'refunded')),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0 AND refunded_minor <= amount_minor),
  provider text NOT NULL CHECK (provider IN ('stripe', 'fake', 'none')),
  provider_checkout_reference text CHECK (length(provider_checkout_reference) <= 255),
  provider_payment_reference text CHECK (length(provider_payment_reference) <= 255),
  failure_code text CHECK (failure_code ~ '^[a-z_]{1,64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  request_fingerprint text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, account_id, idempotency_key),
  CHECK ((payee_type IS NULL) = (payee_id IS NULL)),
  CHECK ((status = 'succeeded') = (succeeded_at IS NOT NULL)),
  CHECK (settlement_status = 'unsettled' OR status = 'succeeded'),
  CHECK (provider <> 'none' OR amount_minor = 0),
  FOREIGN KEY (organization_id, event_id) REFERENCES competitions(organization_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_orders_payment_reference_idx
  ON payment_orders (provider, provider_payment_reference) WHERE provider_payment_reference IS NOT NULL;
--> statement-breakpoint
CREATE INDEX payment_orders_account_idx ON payment_orders (organization_id, account_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX payment_orders_subject_idx ON payment_orders (organization_id, purpose, subject_id, status);
--> statement-breakpoint
CREATE TABLE payment_order_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  order_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, order_id) REFERENCES payment_orders(organization_id, id)
);
--> statement-breakpoint
CREATE TRIGGER payment_order_history_append_only BEFORE UPDATE OR DELETE ON payment_order_history
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TABLE payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  order_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  reason text NOT NULL CHECK (reason IN ('requested_by_customer', 'operator', 'event_cancelled', 'chargeback', 'fraud')),
  provider_refund_reference text CHECK (length(provider_refund_reference) <= 255),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  requested_by_account_id uuid REFERENCES accounts(id),
  ledger_transaction_id uuid,
  failure_code text CHECK (failure_code ~ '^[a-z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  CHECK ((status = 'succeeded') = (ledger_transaction_id IS NOT NULL)),
  CHECK ((status = 'pending') = (completed_at IS NULL)),
  FOREIGN KEY (organization_id, order_id) REFERENCES payment_orders(organization_id, id),
  FOREIGN KEY (organization_id, ledger_transaction_id) REFERENCES ledger_transactions(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX payment_refunds_order_idx ON payment_refunds (organization_id, order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_refunds_provider_reference_idx
  ON payment_refunds (provider_refund_reference) WHERE provider_refund_reference IS NOT NULL;
--> statement-breakpoint
CREATE TABLE payment_webhook_events (
  provider text NOT NULL CHECK (provider IN ('stripe', 'fake')),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
  organization_id uuid REFERENCES organizations(id),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (length(outcome) BETWEEN 1 AND 64),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
--> statement-breakpoint
CREATE TABLE payment_reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider IN ('stripe', 'fake')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL CHECK (window_end > window_start),
  checked_count integer NOT NULL CHECK (checked_count >= 0),
  mismatch_count integer NOT NULL CHECK (mismatch_count >= 0),
  mismatches jsonb NOT NULL,
  created_by_account_id uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
