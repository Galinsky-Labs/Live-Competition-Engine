import * as tenantAdmin from "@live-competition-engine/db/tenant-admin";
import { billingSection, moderationSection } from "@live-competition-engine/db/admin-overview";
import { moderationOverviewCounts } from "@live-competition-engine/db/moderation";
import { createTenantAdminHandlers, type TenantAdminService } from "../app/api/organizations/[organizationId]/admin/handlers";
import { authService } from "./services";

/** PostgreSQL wiring for the LC-43 tenant administration handlers. */
export const tenantAdminService: TenantAdminService = {
  listMembers: tenantAdmin.listMembers,
  setMembershipStatus: (org, actor, account, status) => tenantAdmin.setMembershipStatus(org, actor, account, status),
  grantTenantRole: (org, actor, account, input) => tenantAdmin.grantTenantRole(org, actor, account, input),
  revokeTenantRole: (org, actor, grant) => tenantAdmin.revokeTenantRole(org, actor, grant),
  createInvitation: (org, actor, input) => tenantAdmin.createInvitation(org, actor, input),
  revokeInvitation: (org, actor, id) => tenantAdmin.revokeInvitation(org, actor, id),
  listInvitations: tenantAdmin.listInvitations,
  acceptInvitation: (org, account, token) => tenantAdmin.acceptInvitation(org, account, token),
  listVenues: tenantAdmin.listVenues,
  createVenue: tenantAdmin.createVenue,
  updateVenue: tenantAdmin.updateVenue,
  archiveVenue: tenantAdmin.archiveVenue,
  assignCompetitionVenue: tenantAdmin.assignCompetitionVenue,
  showOverview: org => tenantAdmin.showOverview(org),
  billingSection: org => billingSection(org),
  // LC-46 provides the moderation counts.
  moderationSection: org => moderationSection(org, { counts: moderationOverviewCounts })
};

let handlers: ReturnType<typeof createTenantAdminHandlers> | undefined;

export function tenantAdminHandlers() {
  handlers ??= createTenantAdminHandlers(authService(), tenantAdminService);
  return handlers;
}
