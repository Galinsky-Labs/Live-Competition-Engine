-- LC-12 follows. A member follows a profile, an event (competition) or the tenant itself.
-- Notification consent is a separate explicit opt-in per follow (default false).
CREATE TABLE follows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  follower_account_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('profile', 'competition', 'organization')),
  profile_id uuid,
  competition_id uuid,
  notify_consent boolean NOT NULL DEFAULT false,
  notify_consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (
    (target_type = 'profile' AND profile_id IS NOT NULL AND competition_id IS NULL) OR
    (target_type = 'competition' AND competition_id IS NOT NULL AND profile_id IS NULL) OR
    (target_type = 'organization' AND profile_id IS NULL AND competition_id IS NULL)
  ),
  -- Consent timestamp records when the current consent value was given or withdrawn.
  CHECK (notify_consent = false OR notify_consent_at IS NOT NULL),
  FOREIGN KEY (organization_id, follower_account_id)
    REFERENCES organization_memberships (organization_id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, profile_id) REFERENCES profiles (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, competition_id) REFERENCES competitions (organization_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX follows_unique_target ON follows (
  organization_id, follower_account_id, target_type, COALESCE(profile_id, competition_id, organization_id)
);
--> statement-breakpoint
CREATE INDEX follows_target_idx ON follows (organization_id, target_type, (COALESCE(profile_id, competition_id, organization_id)));
