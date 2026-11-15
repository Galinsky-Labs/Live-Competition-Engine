-- LC-32: versioned revenue split rules and per-order allocations.
CREATE TABLE revenue_split_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid,
  purpose text CHECK (purpose IN ('ticket', 'ppv', 'entry_fee', 'subscription', 'tip', 'gift', 'content')),
  scope_key text GENERATED ALWAYS AS (coalesce(event_id::text, '*') || ':' || coalesce(purpose, '*')) STORED,
  version integer NOT NULL CHECK (version > 0),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 20),
  remainder_line integer NOT NULL CHECK (remainder_line >= 0 AND remainder_line < 20),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, scope_key, version),
  FOREIGN KEY (organization_id, event_id) REFERENCES competitions(organization_id, id)
);
--> statement-breakpoint
-- Rules are versioned, never edited: publish a new version instead.
CREATE TRIGGER revenue_split_rules_immutable BEFORE UPDATE OR DELETE ON revenue_split_rules
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  order_id uuid NOT NULL,
  rule_id uuid,
  ledger_transaction_id uuid NOT NULL,
  gross_minor bigint NOT NULL CHECK (gross_minor > 0),
  remainder_line integer NOT NULL CHECK (remainder_line >= 0),
  allocations jsonb NOT NULL CHECK (jsonb_typeof(allocations) = 'array'),
  active boolean NOT NULL DEFAULT true,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (active = (superseded_at IS NULL)),
  FOREIGN KEY (organization_id, order_id) REFERENCES payment_orders(organization_id, id),
  FOREIGN KEY (organization_id, rule_id) REFERENCES revenue_split_rules(organization_id, id),
  FOREIGN KEY (organization_id, ledger_transaction_id) REFERENCES ledger_transactions(organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_allocations_active_idx ON payment_allocations (organization_id, order_id) WHERE active;
