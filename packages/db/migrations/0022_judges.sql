-- LC-19 judge system: invitations (hashed single-use tokens) and conflict-of-interest recusals.
CREATE TABLE judge_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by_account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_account_id uuid,
  judge_id uuid,
  revoked_at timestamptz,
  revoked_by_account_id uuid,
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_account_id IS NULL) AND (accepted_at IS NULL) = (judge_id IS NULL)),
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (organization_id, created_by_account_id) REFERENCES organization_memberships (organization_id, account_id),
  FOREIGN KEY (organization_id, accepted_account_id) REFERENCES organization_memberships (organization_id, account_id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX judge_invitations_one_open_uniq ON judge_invitations (competition_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE judge_recusals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  judge_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('self_declared','producer')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  declared_by_account_id uuid NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  rescinded_at timestamptz,
  rescinded_by_account_id uuid,
  rescind_reason text CHECK (rescind_reason IS NULL OR length(rescind_reason) BETWEEN 1 AND 1000),
  CHECK ((rescinded_at IS NULL) = (rescinded_by_account_id IS NULL) AND (rescinded_at IS NULL) = (rescind_reason IS NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id),
  FOREIGN KEY (competition_id, judge_id) REFERENCES competition_judges (competition_id, judge_id),
  FOREIGN KEY (organization_id, judge_id) REFERENCES judges (organization_id, id),
  FOREIGN KEY (organization_id, entry_id) REFERENCES entries (organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX judge_recusals_active_uniq ON judge_recusals (competition_id, judge_id, entry_id) WHERE rescinded_at IS NULL;
