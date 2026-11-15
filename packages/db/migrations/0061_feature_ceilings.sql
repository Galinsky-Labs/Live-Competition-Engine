-- LC-44 platform-owned per-tenant feature ceilings. A locked row means tenant
-- operators may not enable the feature at tenant, event or account scope.
CREATE TABLE tenant_feature_ceilings (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature text NOT NULL CHECK (feature ~ '^[a-z][a-z_]{1,40}$'),
  locked boolean NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, feature)
);
--> statement-breakpoint
CREATE INDEX tenant_feature_ceilings_locked_idx ON tenant_feature_ceilings (feature) WHERE locked;
