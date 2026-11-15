-- LC-43 tenant administration: single-use hashed invitations and tenant-owned venues.
CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  initial_role competition_role CHECK (initial_role IS NULL OR initial_role IN ('tenant_operator', 'viewer', 'industry_scout')),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by_account_id uuid NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by_account_id uuid REFERENCES accounts(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (expires_at > created_at),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by_account_id IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX organization_invitations_one_pending_uniq
  ON organization_invitations (organization_id, email) WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  address text CHECK (address IS NULL OR length(address) <= 500),
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 1000000),
  timezone text CHECK (timezone IS NULL OR timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX venues_active_name_uniq ON venues (organization_id, lower(name)) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE TABLE competition_venues (
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  venue_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, competition_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, venue_id) REFERENCES venues(organization_id, id)
);
