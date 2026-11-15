-- LC-35: optional creator content gating (text posts or LC-11 media) with access rules.
CREATE TABLE gated_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  creator_type text NOT NULL CHECK (creator_type IN ('tenant', 'participant', 'account')),
  creator_id uuid,
  event_id uuid,
  kind text NOT NULL CHECK (kind IN ('text', 'media')),
  media_id uuid,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  teaser text NOT NULL DEFAULT '' CHECK (length(teaser) <= 2000),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 100000),
  access_rule text NOT NULL CHECK (access_rule IN ('public', 'members', 'plan', 'purchase')),
  plan_id uuid,
  price_minor bigint CHECK (price_minor IS NULL OR price_minor BETWEEN 1 AND 1000000000000),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK ((creator_type = 'tenant') = (creator_id IS NULL)),
  CHECK ((kind = 'media') = (media_id IS NOT NULL)),
  CHECK ((kind = 'text') = (body IS NOT NULL)),
  CHECK ((access_rule = 'plan') = (plan_id IS NOT NULL)),
  CHECK ((access_rule = 'purchase') = (price_minor IS NOT NULL AND currency IS NOT NULL)),
  FOREIGN KEY (organization_id, event_id) REFERENCES competitions(organization_id, id),
  FOREIGN KEY (organization_id, media_id) REFERENCES media_library(organization_id, id),
  FOREIGN KEY (organization_id, plan_id) REFERENCES membership_plans(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX gated_content_listing_idx ON gated_content (organization_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX gated_content_creator_idx ON gated_content (organization_id, creator_type, creator_id);
