-- LC-47 notifications: a generic durable job queue, per-tenant in-app inbox,
-- preferences, an email outbox and an address suppression list.
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(kind) <= 100),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(payload::text) <= 65536),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 25),
  backoff_base_ms integer NOT NULL DEFAULT 30000 CHECK (backoff_base_ms BETWEEN 100 AND 86400000),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX jobs_idempotency_uniq
  ON jobs (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'queued';
--> statement-breakpoint
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
--> statement-breakpoint
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('account', 'membership', 'event_updates', 'results', 'moderation', 'social', 'marketing')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 4000),
  link text CHECK (link IS NULL OR (link ~ '^/[^/]' AND length(link) <= 500)),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, account_id, idempotency_key),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX notifications_inbox_idx ON notifications (organization_id, account_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE notification_preferences (
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('account', 'membership', 'event_updates', 'results', 'moderation', 'social', 'marketing')),
  channel text NOT NULL CHECK (channel IN ('email', 'in_app')),
  enabled boolean NOT NULL,
  source text NOT NULL DEFAULT 'preferences' CHECK (source IN ('preferences', 'unsubscribe_link')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, account_id, category, channel),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE email_suppressions (
  email text PRIMARY KEY CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  reason text NOT NULL CHECK (reason IN ('hard_bounce', 'spam_complaint', 'manual')),
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid REFERENCES accounts(id),
  notification_id uuid,
  job_id uuid REFERENCES jobs(id),
  category text NOT NULL,
  to_email text NOT NULL CHECK (length(to_email) BETWEEN 3 AND 320),
  from_email text NOT NULL CHECK (length(from_email) BETWEEN 3 AND 400),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300 AND subject !~ '[\r\n]'),
  text_body text NOT NULL CHECK (length(text_body) <= 100000),
  html_body text CHECK (html_body IS NULL OR length(html_body) <= 200000),
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'suppressed', 'bounced', 'complained', 'delivered')),
  provider text,
  provider_message_id text UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, notification_id) REFERENCES notifications(organization_id, id) ON DELETE SET NULL (notification_id)
);
--> statement-breakpoint
CREATE INDEX email_messages_org_status_idx ON email_messages (organization_id, status, created_at DESC);
