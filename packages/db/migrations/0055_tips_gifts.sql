-- LC-36: tips and live gifts with tenant-defined catalog, limits and payout recipients.
CREATE TABLE gift_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 1 AND 1000000000000),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
--> statement-breakpoint
CREATE TABLE tip_policies (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  min_minor bigint NOT NULL CHECK (min_minor > 0),
  max_minor bigint NOT NULL CHECK (max_minor >= min_minor),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 60 AND 604800),
  max_count_per_window integer NOT NULL CHECK (max_count_per_window > 0),
  max_amount_per_window_minor bigint NOT NULL CHECK (max_amount_per_window_minor >= max_minor),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Which member account receives payouts for a participant (also used to block self-tipping).
CREATE TABLE participant_payout_accounts (
  organization_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  linked_by_account_id uuid NOT NULL REFERENCES accounts(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, participant_id),
  FOREIGN KEY (organization_id, participant_id) REFERENCES participants(organization_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE TABLE tips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid NOT NULL,
  sender_account_id uuid NOT NULL REFERENCES accounts(id),
  payee_type text NOT NULL CHECK (payee_type IN ('participant', 'account')),
  payee_id uuid NOT NULL,
  gift_id uuid,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quoted_payee_minor bigint NOT NULL CHECK (quoted_payee_minor >= 0),
  message text CHECK (message IS NULL OR length(message) <= 280),
  order_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, order_id),
  FOREIGN KEY (organization_id, event_id) REFERENCES competitions(organization_id, id),
  FOREIGN KEY (organization_id, gift_id) REFERENCES gift_catalog(organization_id, id),
  FOREIGN KEY (organization_id, order_id) REFERENCES payment_orders(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX tips_sender_window_idx ON tips (organization_id, sender_account_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX tips_event_idx ON tips (organization_id, event_id, created_at DESC);
