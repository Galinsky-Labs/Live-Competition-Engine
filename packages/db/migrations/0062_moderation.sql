-- LC-46 moderation and trust/safety: reports, append-only decisions, generic subject
-- actions, appeals, evidence, legal holds and a small fixed-window rate limiter.
CREATE TABLE moderation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  subject_type text NOT NULL CHECK (subject_type IN ('profile', 'chat_message', 'media', 'critique', 'page', 'event')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  reporter_account_id uuid REFERENCES accounts(id),
  reporter_key char(64) NOT NULL CHECK (reporter_key ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'violence', 'sexual_content', 'self_harm', 'copyright', 'privacy', 'impersonation', 'other')),
  details text CHECK (details IS NULL OR length(details) <= 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'actioned', 'dismissed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_account_id uuid REFERENCES accounts(id),
  UNIQUE (organization_id, id),
  CHECK ((status IN ('actioned', 'dismissed')) = (resolved_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX moderation_reports_queue_idx ON moderation_reports (organization_id, status, created_at);
--> statement-breakpoint
CREATE INDEX moderation_reports_subject_idx ON moderation_reports (organization_id, subject_type, subject_id);
--> statement-breakpoint
CREATE UNIQUE INDEX moderation_reports_one_open_per_reporter_uniq
  ON moderation_reports (organization_id, subject_type, subject_id, reporter_key) WHERE status IN ('open', 'triaged');
--> statement-breakpoint
CREATE TABLE moderation_report_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL,
  report_id uuid NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, report_id) REFERENCES moderation_reports(organization_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  subject_type text NOT NULL CHECK (subject_type IN ('profile', 'chat_message', 'media', 'critique', 'page', 'event')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action IN ('hide', 'takedown')),
  report_id uuid,
  affected_account_id uuid REFERENCES accounts(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  reversed_by_account_id uuid REFERENCES accounts(id),
  reversal_reason text CHECK (reversal_reason IS NULL OR length(reversal_reason) <= 2000),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, report_id) REFERENCES moderation_reports(organization_id, id),
  CHECK ((reversed_at IS NULL) = (reversed_by_account_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX moderation_actions_active_subject_idx
  ON moderation_actions (organization_id, subject_type, subject_id) WHERE reversed_at IS NULL;
--> statement-breakpoint
CREATE TABLE moderation_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  action_id uuid NOT NULL,
  appellant_account_id uuid NOT NULL REFERENCES accounts(id),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'upheld', 'overturned')),
  decided_by_account_id uuid REFERENCES accounts(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (action_id),
  FOREIGN KEY (organization_id, action_id) REFERENCES moderation_actions(organization_id, id),
  CHECK ((status = 'open') = (decided_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE moderation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  report_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('text', 'media')),
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 8000),
  media_id uuid,
  added_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, report_id) REFERENCES moderation_reports(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, media_id) REFERENCES media_library(organization_id, id),
  CHECK ((kind = 'text' AND body IS NOT NULL AND media_id IS NULL) OR (kind = 'media' AND media_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE moderation_legal_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  subject_type text NOT NULL CHECK (subject_type IN ('profile', 'chat_message', 'media', 'critique', 'page', 'event')),
  subject_id text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  placed_by_account_id uuid NOT NULL REFERENCES accounts(id),
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by_account_id uuid REFERENCES accounts(id),
  UNIQUE (organization_id, id),
  CHECK ((released_at IS NULL) = (released_by_account_id IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX moderation_legal_holds_active_uniq
  ON moderation_legal_holds (organization_id, subject_type, subject_id) WHERE released_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION moderation_legal_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  s_type text;
  s_id text;
BEGIN
  IF TG_TABLE_NAME = 'moderation_evidence' OR TG_TABLE_NAME = 'moderation_report_transitions' THEN
    SELECT subject_type, subject_id INTO s_type, s_id FROM moderation_reports
      WHERE organization_id = OLD.organization_id AND id = OLD.report_id;
  ELSE
    s_type := OLD.subject_type;
    s_id := OLD.subject_id;
  END IF;
  IF EXISTS (SELECT 1 FROM moderation_legal_holds WHERE organization_id = OLD.organization_id
      AND subject_type = s_type AND subject_id = s_id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'legal hold active' USING ERRCODE = 'P0001', HINT = 'legal_hold_active';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_reports_legal_hold BEFORE DELETE ON moderation_reports
  FOR EACH ROW EXECUTE FUNCTION moderation_legal_hold_guard();
--> statement-breakpoint
CREATE TRIGGER moderation_actions_legal_hold BEFORE DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION moderation_legal_hold_guard();
--> statement-breakpoint
CREATE TRIGGER moderation_evidence_legal_hold BEFORE DELETE ON moderation_evidence
  FOR EACH ROW EXECUTE FUNCTION moderation_legal_hold_guard();
--> statement-breakpoint
CREATE FUNCTION moderation_transitions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation_report_transitions is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER moderation_report_transitions_no_update BEFORE UPDATE ON moderation_report_transitions
  FOR EACH ROW EXECUTE FUNCTION moderation_transitions_immutable();
--> statement-breakpoint
CREATE TABLE bucket_rate_limits (
  bucket_key text NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 300),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (bucket_key, window_start)
);
--> statement-breakpoint
CREATE INDEX bucket_rate_limits_window_idx ON bucket_rate_limits (window_start);
