-- LC-33: ticket types (tickets and PPV), capacity holds, entry fees, and grant provenance.
CREATE TABLE entitlement_grant_sources (
  grant_id uuid PRIMARY KEY REFERENCES entitlement_grants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source_kind text NOT NULL CHECK (source_kind IN ('payment_order', 'subscription', 'manual')),
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX entitlement_grant_sources_source_idx ON entitlement_grant_sources (organization_id, source_kind, source_id);
--> statement-breakpoint
CREATE TABLE ticket_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ticket', 'ppv')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 1000000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 10000000),
  -- Holds plus issued tickets. The CHECK is the final no-oversell guarantee.
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND (capacity IS NULL OR reserved <= capacity)),
  sales_starts_at timestamptz,
  sales_ends_at timestamptz,
  status text NOT NULL DEFAULT 'on_sale' CHECK (status IN ('on_sale', 'paused', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (sales_ends_at IS NULL OR sales_starts_at IS NULL OR sales_ends_at > sales_starts_at),
  FOREIGN KEY (organization_id, event_id) REFERENCES competitions(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX ticket_types_event_idx ON ticket_types (organization_id, event_id, kind, status);
--> statement-breakpoint
CREATE TABLE ticket_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  ticket_type_id uuid NOT NULL,
  order_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'issued', 'released', 'refunded', 'revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, order_id),
  FOREIGN KEY (organization_id, ticket_type_id) REFERENCES ticket_types(organization_id, id),
  FOREIGN KEY (organization_id, order_id) REFERENCES payment_orders(organization_id, id)
);
--> statement-breakpoint
-- One live (held or issued) ticket per account per ticket type; grants are per account.
CREATE UNIQUE INDEX ticket_reservations_live_idx ON ticket_reservations (organization_id, ticket_type_id, account_id)
  WHERE status IN ('held', 'issued');
--> statement-breakpoint
CREATE INDEX ticket_reservations_expiry_idx ON ticket_reservations (expires_at) WHERE status = 'held';
--> statement-breakpoint
CREATE TABLE entry_fees (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, competition_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX payment_orders_entry_fee_idx ON payment_orders (organization_id, event_id, account_id)
  WHERE purpose = 'entry_fee' AND status = 'succeeded';
