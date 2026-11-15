-- LC-10 public profiles. One generic profile per tenant member; history is derived
-- from published (final) results through participants.account_id, never client input.
ALTER TABLE participants ADD COLUMN account_id uuid;
--> statement-breakpoint
ALTER TABLE participants ADD CONSTRAINT participants_org_account_member_fk
  FOREIGN KEY (organization_id, account_id) REFERENCES organization_memberships (organization_id, account_id);
--> statement-breakpoint
CREATE INDEX participants_org_account_idx ON participants (organization_id, account_id) WHERE account_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_account_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0 AND length(display_name) <= 100),
  bio text NOT NULL DEFAULT '' CHECK (length(bio) <= 2000),
  roles text[] NOT NULL DEFAULT '{}' CHECK (roles <@ ARRAY['performer','producer','judge']::text[] AND cardinality(roles) <= 3),
  visibility text NOT NULL CHECK (visibility IN ('public', 'members', 'private')),
  hidden_at timestamptz,
  hidden_by_account_id uuid REFERENCES accounts(id),
  hidden_reason text CHECK (length(hidden_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, owner_account_id),
  CHECK ((hidden_at IS NULL) = (hidden_by_account_id IS NULL)),
  FOREIGN KEY (organization_id, owner_account_id)
    REFERENCES organization_memberships (organization_id, account_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX profiles_org_visibility_idx ON profiles (organization_id, visibility, id) WHERE hidden_at IS NULL;
--> statement-breakpoint
-- Owner must hold an ACTIVE membership whenever the profile is written.
CREATE FUNCTION profiles_require_active_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships
    WHERE organization_id = NEW.organization_id AND account_id = NEW.owner_account_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'profile owner must be an active member' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.owner_account_id <> OLD.owner_account_id OR NEW.organization_id <> OLD.organization_id) THEN
    RAISE EXCEPTION 'profile owner and tenant are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER profiles_active_owner BEFORE INSERT OR UPDATE OF owner_account_id, organization_id, display_name, bio, roles, visibility
  ON profiles FOR EACH ROW EXECUTE FUNCTION profiles_require_active_owner();
