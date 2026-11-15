-- LC-52 white-label email: sender identities on verified tenant domains, versioned
-- templates, signed unsubscribe keys, delivery events and message source trace.
CREATE UNIQUE INDEX organization_domains_org_id_uniq ON organization_domains (organization_id, id);
--> statement-breakpoint
CREATE TABLE email_sender_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  domain_id uuid NOT NULL,
  local_part text NOT NULL CHECK (local_part ~ '^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$'),
  from_name text NOT NULL CHECK (length(from_name) BETWEEN 1 AND 100 AND from_name !~ '[\r\n<>"\\]'),
  dkim_selector text NOT NULL CHECK (dkim_selector ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  return_path_host text NOT NULL CHECK (length(return_path_host) BETWEEN 4 AND 253 AND return_path_host = lower(return_path_host)),
  dkim_status text NOT NULL DEFAULT 'unknown' CHECK (dkim_status IN ('unknown', 'verified', 'failed')),
  return_path_status text NOT NULL DEFAULT 'unknown' CHECK (return_path_status IN ('unknown', 'verified', 'failed')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'disabled')),
  is_default boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (domain_id, local_part),
  FOREIGN KEY (organization_id, domain_id) REFERENCES organization_domains(organization_id, id),
  CHECK (status <> 'verified' OR (dkim_status = 'verified' AND return_path_status = 'verified'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX email_sender_identities_one_default_uniq ON email_sender_identities (organization_id) WHERE is_default;
--> statement-breakpoint
CREATE TABLE email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9]+([._-][a-z0-9]+)*$' AND length(key) <= 80),
  description text CHECK (description IS NULL OR length(description) <= 500),
  active_version integer,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, key)
);
--> statement-breakpoint
CREATE TABLE email_template_versions (
  organization_id uuid NOT NULL,
  template_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  subject_template text NOT NULL CHECK (length(subject_template) BETWEEN 1 AND 300),
  body_template text NOT NULL CHECK (length(body_template) <= 50000),
  allowed_variables text[] NOT NULL DEFAULT '{}',
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version),
  UNIQUE (organization_id, template_id, version),
  FOREIGN KEY (organization_id, template_id) REFERENCES email_templates(organization_id, id)
);
--> statement-breakpoint
CREATE FUNCTION email_template_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'email_template_versions is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER email_template_versions_no_change BEFORE UPDATE OR DELETE ON email_template_versions
  FOR EACH ROW EXECUTE FUNCTION email_template_versions_immutable();
--> statement-breakpoint
ALTER TABLE email_templates ADD CONSTRAINT email_templates_active_version_fk
  FOREIGN KEY (organization_id, id, active_version) REFERENCES email_template_versions(organization_id, template_id, version)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE email_unsubscribe_keys (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE email_messages
  ADD COLUMN template_id uuid,
  ADD COLUMN template_version integer,
  ADD COLUMN sender_identity_id uuid,
  ADD CONSTRAINT email_messages_template_version_fk
    FOREIGN KEY (organization_id, template_id, template_version) REFERENCES email_template_versions(organization_id, template_id, version),
  ADD CONSTRAINT email_messages_sender_identity_fk
    FOREIGN KEY (organization_id, sender_identity_id) REFERENCES email_sender_identities(organization_id, id);
--> statement-breakpoint
CREATE TABLE email_delivery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  email_message_id uuid NOT NULL,
  provider_message_id text NOT NULL,
  record_type text NOT NULL CHECK (length(record_type) BETWEEN 1 AND 60),
  detail_type text CHECK (detail_type IS NULL OR length(detail_type) <= 60),
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, email_message_id) REFERENCES email_messages(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX email_delivery_events_message_idx ON email_delivery_events (organization_id, email_message_id, received_at);
