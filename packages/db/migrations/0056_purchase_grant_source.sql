-- Item-scoped purchase grants (LC-35). A "purchase" grant proves access only to the
-- specific item recorded in entitlement_grant_sources; the generic LC-09 resolver
-- never treats it as tenant-wide content.view.
ALTER TABLE entitlement_grants DROP CONSTRAINT entitlement_grants_source_check;
--> statement-breakpoint
ALTER TABLE entitlement_grants ADD CONSTRAINT entitlement_grants_source_check
  CHECK (source IN ('ticket','subscription','staff','manual','purchase'));
