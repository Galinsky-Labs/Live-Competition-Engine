import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthenticationService } from "@live-competition-engine/auth";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createPostgresAuthStore } from "./auth-store.ts";
import { listAuditEvents, verifyAuditChain } from "./audit.ts";
import { createAccount, createTenant, grantRole } from "./test-fixtures.ts";
import { createFirstEvent } from "./tenant-signup.ts";
import {
  addAnnouncementVersion,
  addSupportNote,
  assertTenantActive,
  changeTenantLifecycle,
  createAnnouncement,
  getTenantDetail,
  listFraudFlags,
  listSupportNotes,
  listTenantAnnouncements,
  listTenants,
  platformAudit,
  publishAnnouncementVersion,
  raiseFraudFlag,
  requireStepUp,
  resolveFraudFlag,
  revokeStepUp,
  stepUpWithFreshSession,
  stepUpWithRecoveryCode,
  withdrawAnnouncement
} from "./platform-admin.ts";

after(closeDatabaseConnection);

const auth = new AuthenticationService(createPostgresAuthStore());

async function platformOperator() {
  const accountId = await createAccount();
  await grantRole(accountId, "platform_operator");
  const { token, session } = await auth.issueSession(accountId);
  const codes = await auth.createRecoveryCodes(accountId, 4);
  return { actor: { accountId, sessionId: session.id }, token, codes };
}

test("step-up grants: recovery code or fresh session, bound to the session, expiring after 10 minutes", async () => {
  const { actor, token, codes } = await platformOperator();
  await assert.rejects(stepUpWithRecoveryCode(actor, "not-a-code"), { code: "step_up_failed" });
  await assert.rejects(stepUpWithRecoveryCode(actor, "A".repeat(24)), { code: "step_up_failed" });
  const grant = await stepUpWithRecoveryCode(actor, codes[0]);
  assert.equal(grant.method, "recovery_code");
  await assert.rejects(stepUpWithRecoveryCode(actor, codes[0]), { code: "step_up_failed" }, "recovery codes are single-use");
  // Spending a recovery code for step-up does not revoke the operator's session.
  await auth.authorizeAction(`Bearer ${token}`, "platform.manage");

  assert.equal(await requireStepUp(actor, grant.token), grant.id);
  const otherSession = await auth.issueSession(actor.accountId);
  await assert.rejects(requireStepUp({ accountId: actor.accountId, sessionId: otherSession.session.id }, grant.token), { code: "step_up_required" });
  const someoneElse = await platformOperator();
  await assert.rejects(requireStepUp(someoneElse.actor, grant.token), { code: "step_up_required" });
  await assert.rejects(requireStepUp(actor, grant.token, new Date(grant.expiresAt.getTime() + 1)), { code: "step_up_required" });
  await assert.rejects(requireStepUp(actor, null), { code: "step_up_required" });
  // The 10-minute ceiling is also a database constraint.
  await assert.rejects(getSqlClient()`UPDATE step_up_grants SET expires_at = expires_at + interval '1 hour' WHERE id = ${grant.id}`, /check constraint/);

  // Fresh session (re-authentication) path.
  const fresh = await stepUpWithFreshSession(actor);
  assert.equal(fresh.method, "fresh_session");
  await assert.rejects(stepUpWithFreshSession(actor, new Date(Date.now() + 6 * 60 * 1000)), { code: "step_up_failed" });
  assert.equal(await revokeStepUp(actor), 2);
  await assert.rejects(requireStepUp(actor, fresh.token), { code: "step_up_required" });

  // A revoked session invalidates its grants.
  const later = await stepUpWithRecoveryCode(actor, codes[1]);
  await auth.revoke(token);
  await assert.rejects(requireStepUp(actor, later.token), { code: "step_up_required" });
  await assert.rejects(stepUpWithRecoveryCode(actor, codes[2]), { code: "step_up_failed" });
});

test("tenant lifecycle: destructive actions need step-up; suspension blocks tenant APIs; deletion has a 30-day grace", async () => {
  const { actor, codes } = await platformOperator();
  const org = await createTenant();
  const tenantActor = await createAccount(org);
  const change = (action: string, expectedRevision: number, stepUp: string | null = null) =>
    changeTenantLifecycle(actor, org, { action, reason: `test ${action}`, expectedRevision }, stepUp);

  await assertTenantActive(org);
  await assert.rejects(change("suspend", 0), { code: "step_up_required" });
  await assert.rejects(change("reactivate", 0), { code: "invalid_state_tenant_transition" });
  await assert.rejects(changeTenantLifecycle(actor, org, { action: "impersonate", reason: "nope", expectedRevision: 0 }, null), { code: "invalid_lifecycle_action" });
  const { token } = await stepUpWithRecoveryCode(actor, codes[0]);
  await assert.rejects(change("suspend", 7, token), { code: "tenant_revision_conflict" });

  const suspended = await change("suspend", 0, token);
  assert.equal(suspended.status, "suspended");
  await assert.rejects(assertTenantActive(org), { code: "tenant_suspended" });
  await assert.rejects(createFirstEvent(org, tenantActor, { title: "Blocked" }, { assertActive: assertTenantActive }), { code: "tenant_suspended" });

  const reactivated = await change("reactivate", 1);
  assert.equal(reactivated.status, "active");
  const scheduled = await change("schedule_deletion", 2, token);
  assert.equal(scheduled.status, "scheduled_deletion");
  const graceDays = (scheduled.deletionScheduledFor!.getTime() - Date.now()) / 86_400_000;
  assert.ok(graceDays > 29.9 && graceDays <= 30);
  await assert.rejects(assertTenantActive(org), { code: "tenant_scheduled_for_deletion" });
  await assert.rejects(change("finalize_deletion", 3, token), { code: "invalid_state_deletion_grace_period" });
  const cancelled = await change("cancel_deletion", 3);
  assert.equal(cancelled.status, "suspended");
  assert.equal(cancelled.deletionScheduledFor, null);

  await change("schedule_deletion", 4, token);
  await getSqlClient()`UPDATE organizations SET deletion_scheduled_for = now() - interval '1 day' WHERE id = ${org}`;
  const deleted = await change("finalize_deletion", 5, token);
  assert.equal(deleted.status, "deleted");
  await assert.rejects(assertTenantActive(org), { code: "tenant_deleted" });
  await assert.rejects(change("reactivate", 6), { code: "invalid_state_tenant_transition" });
  await assert.rejects(assertTenantActive(randomUUID()), { code: "tenant_not_found" });

  const detail = await getTenantDetail(org);
  assert.deepEqual(detail!.lifecycle.map(e => e.action), ["finalize_deletion", "schedule_deletion", "cancel_deletion", "schedule_deletion", "reactivate", "suspend"]);
  await assert.rejects(getSqlClient()`UPDATE organization_lifecycle_events SET reason = 'edited' WHERE organization_id = ${org}`, /append-only/);
  const audit = await listAuditEvents(null, { subjectType: "organization", subjectId: org });
  assert.equal(audit.filter(e => e.action.startsWith("platform.tenant_")).length, 6);
  assert.equal((await verifyAuditChain(null)).valid, true);
  assert.equal((await listTenants({ status: "deleted", query: org })).length, 1);
});

test("concurrent lifecycle changes on one tenant: exactly one wins", async () => {
  const { actor, codes } = await platformOperator();
  const org = await createTenant();
  const { token } = await stepUpWithRecoveryCode(actor, codes[0]);
  const results = await Promise.allSettled([1, 2, 3].map(() =>
    changeTenantLifecycle(actor, org, { action: "suspend", reason: "race", expectedRevision: 0 }, token)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});

test("fraud flags and support notes are scoped to their subject", async () => {
  const { actor } = await platformOperator();
  const orgA = await createTenant();
  const orgB = await createTenant();
  const account = await createAccount(orgA);

  const orgFlag = await raiseFraudFlag(actor, { subjectType: "organization", subjectId: orgA, severity: "high", reason: "chargeback spike" });
  const accountFlag = await raiseFraudFlag(actor, { subjectType: "account", subjectId: account, severity: "low", reason: "disposable email" });
  await assert.rejects(raiseFraudFlag(actor, { subjectType: "account", subjectId: randomUUID(), severity: "low", reason: "ghost" }), { code: "flag_subject_not_found" });
  assert.deepEqual((await listFraudFlags({ organizationId: orgA })).map(f => f.id), [orgFlag.id]);
  assert.deepEqual(await listFraudFlags({ organizationId: orgB }), []);
  assert.deepEqual((await listFraudFlags({ accountId: account })).map(f => f.id), [accountFlag.id]);
  assert.equal((await listTenants({ query: orgA }))[0]!.openFraudFlags, 1);

  await assert.rejects(resolveFraudFlag(actor, orgFlag.id, "false positive", 9), { code: "flag_revision_conflict" });
  const resolved = await resolveFraudFlag(actor, orgFlag.id, "false positive", 1);
  assert.equal(resolved.status, "resolved");
  await assert.rejects(resolveFraudFlag(actor, orgFlag.id, "again", 2), { code: "invalid_state_flag_resolved" });
  await assert.rejects(resolveFraudFlag(actor, randomUUID(), "missing", 1), { code: "flag_not_found" });

  const note = await addSupportNote(actor, orgA, "Customer asked about invoices");
  assert.deepEqual((await listSupportNotes(orgA)).map(n => n.id), [note.id]);
  assert.deepEqual(await listSupportNotes(orgB), []);
  await assert.rejects(addSupportNote(actor, randomUUID(), "x"), { code: "tenant_not_found" });
  await assert.rejects(addSupportNote(actor, orgA, ""), { code: "invalid_note" });
  await assert.rejects(getSqlClient()`UPDATE platform_support_notes SET body = 'edited' WHERE id = ${note.id}`, /append-only/);
  const [noteAudit] = await listAuditEvents(null, { subjectType: "organization", subjectId: orgA });
  assert.ok(!JSON.stringify(noteAudit).includes("invoices"), "note text stays out of the audit log");
});

test("announcements are versioned, immutable once published, targeted and withdrawable", async () => {
  const { actor } = await platformOperator();
  const orgA = await createTenant();
  const orgB = await createTenant();
  const visible = async (org: string, id: string) => (await listTenantAnnouncements(org)).filter(a => a.id === id);

  const v1 = await createAnnouncement(actor, "release_note", { title: "Engine 2.0", body: "New scoring", severity: "info" });
  const id = v1.announcementId;
  assert.deepEqual(await visible(orgA, id), [], "drafts are not visible");
  await publishAnnouncementVersion(actor, id, 1);
  assert.equal((await visible(orgA, id))[0]?.version, 1);
  assert.equal((await visible(orgB, id))[0]?.version, 1);
  await assert.rejects(publishAnnouncementVersion(actor, id, 1), { code: "invalid_state_version_published" });
  await assert.rejects(getSqlClient()`UPDATE platform_announcement_versions SET body = 'edited' WHERE announcement_id = ${id} AND version = 1`, /immutable/);

  const v2 = await addAnnouncementVersion(actor, id, { title: "Engine 2.0.1", body: "Fix for A", targetOrganizationIds: [orgA] });
  assert.equal(v2.version, 2);
  await publishAnnouncementVersion(actor, id, 2);
  assert.equal((await visible(orgA, id))[0]?.title, "Engine 2.0.1");
  assert.deepEqual(await visible(orgB, id), [], "the current version targets tenant A only");
  await assert.rejects(publishAnnouncementVersion(actor, id, 9), { code: "announcement_version_not_found" });

  await withdrawAnnouncement(actor, id);
  assert.deepEqual(await visible(orgA, id), []);
  await assert.rejects(withdrawAnnouncement(actor, id), { code: "invalid_state_announcement_withdrawn" });
  await assert.rejects(addAnnouncementVersion(actor, id, { title: "t", body: "b" }), { code: "invalid_state_announcement_withdrawn" });
  await assert.rejects(createAnnouncement(actor, "banner", { title: "t", body: "b" }), { code: "invalid_announcement" });

  const audit = await platformAudit({ limit: 5 });
  assert.equal(audit.verification.valid, true);
  assert.ok(audit.events.length > 0);
});
