-- LC-27 audience interaction: consent, reactions, chat, questions, polls, moderation.
CREATE UNIQUE INDEX IF NOT EXISTS performances_org_competition_id_uniq
  ON performances (organization_id, competition_id, id);
--> statement-breakpoint
CREATE TABLE audience_settings (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  competition_id uuid NOT NULL,
  terms_version text NOT NULL CHECK (terms_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  slow_mode_seconds integer NOT NULL DEFAULT 0 CHECK (slow_mode_seconds BETWEEN 0 AND 3600),
  chat_max_length integer NOT NULL DEFAULT 500 CHECK (chat_max_length BETWEEN 1 AND 1000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, competition_id),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id)
);
--> statement-breakpoint
CREATE TABLE audience_consents (
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  account_id uuid NOT NULL,
  terms_version text NOT NULL CHECK (terms_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, competition_id, account_id, terms_version),
  FOREIGN KEY (organization_id, competition_id) REFERENCES audience_settings(organization_id, competition_id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE TABLE audience_reaction_counts (
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  performance_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('applause','heart','star','wow','laugh')),
  count bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, competition_id, performance_id, kind),
  FOREIGN KEY (organization_id, competition_id, performance_id)
    REFERENCES performances(organization_id, competition_id, id)
);
--> statement-breakpoint
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  account_id uuid NOT NULL,
  body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  moderated_by_account_id uuid REFERENCES accounts(id),
  moderated_at timestamptz,
  moderation_reason text CHECK (moderation_reason IS NULL OR length(moderation_reason) <= 500),
  UNIQUE (organization_id, id),
  CHECK ((status = 'deleted') = (body IS NULL)),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE INDEX chat_messages_feed_idx ON chat_messages (organization_id, competition_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX chat_messages_author_idx ON chat_messages (organization_id, competition_id, account_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE chat_mutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  account_id uuid NOT NULL,
  muted_until timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (muted_until > created_at),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE INDEX chat_mutes_active_idx ON chat_mutes (organization_id, competition_id, account_id, muted_until) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE audience_blocked_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  term text NOT NULL CHECK (length(term) BETWEEN 1 AND 64),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, term),
  UNIQUE (organization_id, id)
);
--> statement-breakpoint
CREATE TABLE audience_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  account_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 3 AND 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  upvote_count integer NOT NULL DEFAULT 0 CHECK (upvote_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by_account_id uuid REFERENCES accounts(id),
  decided_at timestamptz,
  UNIQUE (organization_id, id),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE INDEX audience_questions_feed_idx ON audience_questions (organization_id, competition_id, status, upvote_count DESC);
--> statement-breakpoint
CREATE TABLE audience_question_upvotes (
  organization_id uuid NOT NULL,
  question_id uuid NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, question_id, account_id),
  FOREIGN KEY (organization_id, question_id) REFERENCES audience_questions(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
--> statement-breakpoint
CREATE TABLE audience_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  competition_id uuid NOT NULL,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  results_visibility text NOT NULL CHECK (results_visibility IN ('live','after_close','never')),
  closes_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz,
  closed_at timestamptz,
  UNIQUE (organization_id, id),
  CHECK (status <> 'draft' OR opened_at IS NULL),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL),
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions(organization_id, id)
);
--> statement-breakpoint
CREATE INDEX audience_polls_competition_idx ON audience_polls (organization_id, competition_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE audience_poll_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  poll_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  UNIQUE (poll_id, ordinal),
  UNIQUE (organization_id, poll_id, id),
  FOREIGN KEY (organization_id, poll_id) REFERENCES audience_polls(organization_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE audience_poll_votes (
  organization_id uuid NOT NULL,
  poll_id uuid NOT NULL,
  account_id uuid NOT NULL,
  option_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, poll_id, account_id),
  FOREIGN KEY (organization_id, poll_id, option_id) REFERENCES audience_poll_options(organization_id, poll_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships(organization_id, account_id)
);
