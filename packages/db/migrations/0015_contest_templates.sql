-- LC-14 versioned contest templates. Published versions are immutable; at most one
-- draft per template. Events store the applied version id plus a resolved snapshot.
CREATE TABLE contest_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX contest_templates_org_name_uniq ON contest_templates (organization_id, lower(name));
--> statement-breakpoint
CREATE TABLE contest_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 65536),
  config_hash char(64) NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  published_by_account_id uuid REFERENCES accounts(id),
  UNIQUE (organization_id, id),
  UNIQUE (template_id, version),
  CHECK ((status = 'published') = (published_at IS NOT NULL) AND (published_at IS NULL) = (published_by_account_id IS NULL)),
  FOREIGN KEY (organization_id, template_id) REFERENCES contest_templates (organization_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX contest_template_versions_one_draft ON contest_template_versions (template_id) WHERE status = 'draft';
--> statement-breakpoint
CREATE FUNCTION contest_template_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published contest template versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contest_template_versions_guard BEFORE UPDATE OR DELETE ON contest_template_versions
  FOR EACH ROW EXECUTE FUNCTION contest_template_versions_immutable();
--> statement-breakpoint
ALTER TABLE competitions
  ADD COLUMN template_version_id uuid,
  ADD COLUMN template_snapshot jsonb,
  ADD COLUMN template_applied_at timestamptz,
  ADD CONSTRAINT competitions_template_version_fk FOREIGN KEY (organization_id, template_version_id)
    REFERENCES contest_template_versions (organization_id, id),
  ADD CONSTRAINT competitions_template_consistency CHECK (
    (template_version_id IS NULL) = (template_snapshot IS NULL) AND (template_snapshot IS NULL) = (template_applied_at IS NULL)
  );
