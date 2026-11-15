-- LC-13 event creation and LC-14 versioned contest configuration.
ALTER TABLE competitions
  ADD COLUMN slug text,
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN capacity integer CHECK (capacity IS NULL OR capacity > 0),
  ADD COLUMN venue jsonb,
  ADD COLUMN remote boolean NOT NULL DEFAULT false,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN template_id uuid,
  ADD COLUMN template_version integer,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text,
  ADD COLUMN created_by_account_id uuid REFERENCES accounts(id),
  ADD CONSTRAINT competitions_time_order CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at);
CREATE UNIQUE INDEX competitions_org_slug_uniq ON competitions (organization_id, slug) WHERE slug IS NOT NULL;

CREATE TABLE competition_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  config jsonb NOT NULL,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competition_templates_version_uniq UNIQUE (organization_id, key, version),
  CONSTRAINT competition_templates_org_id_uniq UNIQUE (organization_id, id)
);

CREATE FUNCTION competition_templates_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'competition template versions are immutable';
END;
$$;
CREATE TRIGGER competition_templates_no_mutation BEFORE UPDATE OR DELETE ON competition_templates
  FOR EACH ROW EXECUTE FUNCTION competition_templates_immutable();

ALTER TABLE competitions
  ADD CONSTRAINT competitions_template_tenant_fk FOREIGN KEY (organization_id, template_id)
  REFERENCES competition_templates (organization_id, id);
