import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant, grantRole } from "./test-fixtures.ts";
import { listAuditEvents } from "./audit.ts";
import {
  acceptInvitation,
  archiveVenue,
  assignCompetitionVenue,
  createInvitation,
  createVenue,
  grantTenantRole,
  listMembers,
  revokeTenantRole,
  setMembershipStatus,
  showOverview,
  updateVenue
} from "./tenant-admin.ts";
import { billingSection, moderationSection } from "./admin-overview.ts";

after(closeDatabaseConnection);

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return "no_error";
};

async function emailOf(accountId: string) {
  const [row] = await getSqlClient()<{ email: string }[]>`SELECT email FROM accounts WHERE id = ${accountId}`;
  return row!.email;
}

test("invitation is hashed, single-use, email-bound and creates membership plus role", async () => {
  const org = await createTenant();
  const operator = await createAccount(org);
  await grantRole(operator, "tenant_operator", { organizationId: org });
  const invitee = await createAccount();
  const stranger = await createAccount();
  const invite = await createInvitation(org, operator, { email: (await emailOf(invitee)).toUpperCase(), initialRole: "viewer" });
  const [stored] = await getSqlClient()<{ token_hash: string }[]>`SELECT token_hash FROM organization_invitations WHERE id = ${invite.id}`;
  assert.notEqual(stored!.token_hash, invite.token);
  assert.equal(await code(acceptInvitation(org, stranger, invite.token)), "forbidden");
  const otherOrg = await createTenant();
  assert.equal(await code(acceptInvitation(otherOrg, invitee, invite.token)), "invitation_not_found");
  const accepted = await acceptInvitation(org, invitee, invite.token);
  assert.equal(accepted.membershipCreated, true);
  assert.ok(accepted.roleGrantId);
  assert.equal(await code(acceptInvitation(org, invitee, invite.token)), "invitation_not_found");
  const members = await listMembers(org);
  const member = members.find(row => row.accountId === invitee);
  assert.equal(member?.grants[0]?.role, "viewer");
  const audit = await listAuditEvents(org, { subjectType: "organization_invitation", subjectId: invite.id });
  assert.deepEqual(audit.map(row => row.action).sort(), ["tenant.invitation_accepted", "tenant.invitation_created"]);
});

test("expired invitations cannot be accepted", async () => {
  const org = await createTenant();
  const operator = await createAccount(org);
  const invitee = await createAccount();
  const created = new Date(Date.now() - 120_000);
  const invite = await createInvitation(org, operator, { email: await emailOf(invitee), ttlMs: 60_000 }, created);
  assert.equal(await code(acceptInvitation(org, invitee, invite.token)), "invitation_expired");
});

test("concurrent acceptance of one invitation succeeds exactly once", async () => {
  const org = await createTenant();
  const operator = await createAccount(org);
  const invitee = await createAccount();
  const invite = await createInvitation(org, operator, { email: await emailOf(invitee) });
  const results = await Promise.allSettled([1, 2, 3].map(() => acceptInvitation(org, invitee, invite.token)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
});

test("role grants: tenant-only, never platform_operator, revoke preserves the row", async () => {
  const org = await createTenant();
  const otherOrg = await createTenant();
  const operator = await createAccount(org);
  const member = await createAccount(org);
  const outsider = await createAccount(otherOrg);
  const competition = await createCompetition(org);
  const foreignCompetition = await createCompetition(otherOrg);
  assert.equal(await code(grantTenantRole(org, operator, member, { role: "platform_operator" })), "role_not_grantable");
  assert.equal(await code(grantTenantRole(org, operator, outsider, { role: "viewer" })), "member_not_found");
  assert.equal(await code(grantTenantRole(org, operator, member, { role: "judge", competitionId: foreignCompetition })), "competition_not_found");
  const results = await Promise.allSettled([1, 2].map(() => grantTenantRole(org, operator, member, { role: "judge", competitionId: competition })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const grant = (results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value;
  assert.equal(await code(revokeTenantRole(otherOrg, operator, grant.id)), "role_grant_not_found");
  await revokeTenantRole(org, operator, grant.id);
  const [row] = await getSqlClient()<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM role_grants WHERE id = ${grant.id}`;
  assert.ok(row?.revoked_at);
  assert.equal(await code(revokeTenantRole(org, operator, grant.id)), "invalid_state_role_grant_revoked");
  const own = await grantRole(operator, "tenant_operator", { organizationId: org });
  assert.equal(await code(revokeTenantRole(org, operator, own)), "cannot_revoke_own_operator_grant");
});

test("suspend and reactivate membership with audit; cannot cross tenants or self", async () => {
  const org = await createTenant();
  const otherOrg = await createTenant();
  const operator = await createAccount(org);
  const member = await createAccount(org);
  assert.equal(await code(setMembershipStatus(otherOrg, operator, member, "suspended")), "member_not_found");
  assert.equal(await code(setMembershipStatus(org, operator, operator, "suspended")), "cannot_change_own_membership");
  await setMembershipStatus(org, operator, member, "suspended");
  assert.equal(await code(setMembershipStatus(org, operator, member, "suspended")), "invalid_state_membership_already_suspended");
  assert.equal((await listMembers(org)).find(row => row.accountId === member)?.status, "suspended");
  await setMembershipStatus(org, operator, member, "active");
  const audit = await listAuditEvents(org, { subjectType: "account", subjectId: member });
  assert.deepEqual(audit.map(row => row.action), ["tenant.member_reactivated", "tenant.member_suspended"]);
});

test("venues CRUD with optimistic revision and tenant isolation, show overview", async () => {
  const org = await createTenant();
  const otherOrg = await createTenant();
  const operator = await createAccount(org);
  const venue = await createVenue(org, operator, { name: "Main Hall", capacity: 200 });
  assert.equal(await code(createVenue(org, operator, { name: "main hall" })), "venue_name_conflict");
  assert.equal(await code(updateVenue(otherOrg, operator, venue.id, { name: "X", expectedRevision: 1 })), "venue_not_found");
  const updated = await updateVenue(org, operator, venue.id, { name: "Main Hall", capacity: 250, expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(await code(updateVenue(org, operator, venue.id, { name: "Main Hall", expectedRevision: 1 })), "venue_revision_conflict");
  const competition = await createCompetition(org, "Spring showcase");
  const foreign = await createCompetition(otherOrg);
  assert.equal(await code(assignCompetitionVenue(org, operator, foreign, venue.id)), "competition_not_found");
  await assignCompetitionVenue(org, operator, competition, venue.id);
  const overview = await showOverview(org);
  assert.equal(overview.statusCounts.draft, 1);
  assert.equal(overview.competitions[0]?.venueName, "Main Hall");
  assert.equal((await showOverview(otherOrg)).competitions.some(row => row.id === competition), false);
  await archiveVenue(org, operator, venue.id);
  assert.equal(await code(assignCompetitionVenue(org, operator, competition, venue.id)), "venue_not_found");
});

test("optional overview sections default to not configured and isolate provider failures", async () => {
  assert.deepEqual(await billingSection("00000000-0000-4000-8000-000000000000"), { status: "not_configured" });
  assert.deepEqual(await moderationSection("x", { counts: async () => { throw new Error("down"); } }), { status: "unavailable" });
});
