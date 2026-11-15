-- LC-45 content management: tenant pages with drafts, immutable published versions,
-- scheduled publication snapshots and navigation entries.
CREATE TABLE cms_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  draft_title text NOT NULL CHECK (length(draft_title) BETWEEN 1 AND 200),
  draft_body text NOT NULL CHECK (length(draft_body) <= 100000),
  draft_media_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(draft_media_ids) <= 50),
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_version integer CHECK (published_version IS NULL OR published_version > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, slug)
);
--> statement-breakpoint
CREATE TABLE cms_page_versions (
  organization_id uuid NOT NULL,
  page_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 100000),
  rendered_html text NOT NULL,
  media_ids uuid[] NOT NULL DEFAULT '{}',
  source text NOT NULL CHECK (source IN ('publish', 'rollback', 'schedule')),
  source_version integer,
  published_by_account_id uuid NOT NULL REFERENCES accounts(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, version),
  FOREIGN KEY (organization_id, page_id) REFERENCES cms_pages(organization_id, id),
  CHECK ((source = 'rollback') = (source_version IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION cms_page_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cms_page_versions is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cms_page_versions_no_change BEFORE UPDATE OR DELETE ON cms_page_versions
  FOR EACH ROW EXECUTE FUNCTION cms_page_versions_immutable();
--> statement-breakpoint
CREATE TABLE cms_scheduled_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  page_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 100000),
  media_ids uuid[] NOT NULL DEFAULT '{}',
  publish_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'cancelled')),
  published_version integer,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, page_id) REFERENCES cms_pages(organization_id, id),
  CHECK ((status = 'published') = (published_version IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX cms_scheduled_one_pending_uniq ON cms_scheduled_publications (page_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX cms_scheduled_due_idx ON cms_scheduled_publications (publish_at) WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE cms_navigation_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  page_id uuid,
  url text CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 2000)),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, page_id) REFERENCES cms_pages(organization_id, id),
  CHECK ((page_id IS NULL) <> (url IS NULL)),
  UNIQUE (organization_id, position)
);
