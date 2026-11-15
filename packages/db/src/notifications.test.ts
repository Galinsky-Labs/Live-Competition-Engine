import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createTenant, enableFeature } from "./test-fixtures.ts";
import { runJobs } from "./jobs.ts";
import { createFakeEmailProvider } from "./providers/email.ts";
import {
  applyProviderEvent,
  canNotify,
  createEmailJobHandler,
  EMAIL_JOB_KIND,
  listInbox,
  markAllRead,
  markRead,
  notify,
  parsePostmarkEvent,
  setPreferences
} from "./notifications.ts";

after(closeDatabaseConnection);

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return "no_error";
};

async function tenantWithNotifications() {
  const org = await createTenant();
  const account = await createAccount(org);
  await enableFeature("notifications", org, account);
  await enableFeature("email", org, account);
  return { org, account };
}

const message = (overrides: Record<string, unknown> = {}) => ({
  category: "results", title: "Results are in", body: "You placed second.", idempotencyKey: `k-${randomUUID()}`, ...overrides
});

async function emailRow(id: string) {
  const [row] = await getSqlClient()<{ status: string; provider_message_id: string | null; to_email: string; job_id: string }[]>`
    SELECT status, provider_message_id, to_email, job_id FROM email_messages WHERE id = ${id}`;
  return row!;
}

test("notify creates an in-app notification and a queued email, idempotently", async () => {
  const { org, account } = await tenantWithNotifications();
  const input = { ...message(), accountId: account };
  const first = await notify(org, input);
  const again = await notify(org, input);
  assert.ok(first.notificationId && first.emailMessageId);
  assert.equal(again.notificationId, first.notificationId);
  assert.equal(again.emailMessageId, first.emailMessageId);
  assert.equal((await emailRow(first.emailMessageId!)).status, "queued");
  const inbox = await listInbox(org, account);
  assert.equal(inbox.unread, 1);
  await markRead(org, account, first.notificationId!);
  assert.equal((await listInbox(org, account, { unreadOnly: true })).notifications.length, 0);
});

test("marketing is opt-in and preferences are respected per channel", async () => {
  const { org, account } = await tenantWithNotifications();
  assert.deepEqual(await canNotify(org, account, "marketing", "email"), { allowed: false, reason: "preference_off" });
  const result = await notify(org, { ...message({ category: "marketing" }), accountId: account });
  assert.equal(result.notificationId, null);
  assert.equal(result.emailMessageId, null);
  await setPreferences(org, account, [{ category: "marketing", channel: "in_app", enabled: true }, { category: "results", channel: "email", enabled: false }]);
  assert.deepEqual(await canNotify(org, account, "marketing", "in_app"), { allowed: true });
  const results = await notify(org, { ...message(), accountId: account });
  assert.ok(results.notificationId);
  assert.equal(results.emailMessageId, null);
});

test("privacy isolation: an account's notifications never cross tenants", async () => {
  const a = await tenantWithNotifications();
  const b = await createTenant();
  await getSqlClient()`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${b}, ${a.account})`;
  await enableFeature("notifications", b, a.account);
  const created = await notify(a.org, { ...message(), accountId: a.account }, { channels: ["in_app"] });
  assert.equal((await listInbox(b, a.account)).notifications.length, 0);
  assert.equal(await code(markRead(b, a.account, created.notificationId!)), "notification_not_found");
  assert.equal(await markAllRead(b, a.account), 0);
  const outsider = await createAccount(b);
  assert.deepEqual(await canNotify(a.org, outsider, "results", "in_app"), { allowed: false, reason: "not_member" });
  assert.equal(await code(notify(a.org, { ...message(), accountId: outsider }).then(r => { if (r.notificationId) throw new Error("leak"); })), "no_error");
});

test("feature flags gate channels", async () => {
  const org = await createTenant();
  const account = await createAccount(org);
  await getSqlClient()`
    INSERT INTO feature_flags (scope_key, feature, scope, organization_id, enabled, revision, updated_by_account_id)
    VALUES (${`tenant:${org}`}, 'email', 'tenant', ${org}, false, 1, ${account})`;
  assert.deepEqual(await canNotify(org, account, "results", "email"), { allowed: false, reason: "feature_disabled" });
});

test("email worker sends once, retries transient failures and records provider id", async () => {
  const { org, account } = await tenantWithNotifications();
  const { emailMessageId } = await notify(org, { ...message(), accountId: account }, { channels: ["email"] });
  const failing = createFakeEmailProvider({ fail: "transient" });
  const first = await runJobs({ [EMAIL_JOB_KIND]: createEmailJobHandler(failing) }, { organizationIds: [org] });
  assert.equal(first.retried, 1);
  assert.equal((await emailRow(emailMessageId!)).status, "queued");
  // Make the retry due now, then succeed.
  await getSqlClient()`UPDATE jobs SET run_at = now() WHERE id = ${(await emailRow(emailMessageId!)).job_id}`;
  const provider = createFakeEmailProvider();
  const second = await runJobs({ [EMAIL_JOB_KIND]: createEmailJobHandler(provider) }, { organizationIds: [org] });
  assert.equal(second.succeeded, 1);
  assert.equal(provider.sent.length, 1);
  const row = await emailRow(emailMessageId!);
  assert.equal(row.status, "sent");
  assert.ok(row.provider_message_id?.startsWith("fake-"));
  const third = await runJobs({ [EMAIL_JOB_KIND]: createEmailJobHandler(provider) }, { organizationIds: [org] });
  assert.equal(third.claimed, 0);
});

test("hard bounces and complaints suppress the address; later sends are suppressed", async () => {
  const { org, account } = await tenantWithNotifications();
  const { emailMessageId } = await notify(org, { ...message(), accountId: account }, { channels: ["email"] });
  const provider = createFakeEmailProvider();
  await runJobs({ [EMAIL_JOB_KIND]: createEmailJobHandler(provider) }, { organizationIds: [org] });
  const sent = await emailRow(emailMessageId!);
  const event = parsePostmarkEvent({ RecordType: "Bounce", Type: "HardBounce", MessageID: sent.provider_message_id, Email: sent.to_email.toUpperCase(), Inactive: true });
  assert.equal((await applyProviderEvent(event!)).action, "suppressed");
  assert.equal((await emailRow(emailMessageId!)).status, "bounced");
  assert.deepEqual(await canNotify(org, account, "results", "email"), { allowed: false, reason: "suppressed" });
  const soft = parsePostmarkEvent({ RecordType: "Bounce", Type: "SoftBounce", MessageID: "unknown", Email: "x@example.org" });
  assert.equal((await applyProviderEvent(soft!)).action, "ignored");
});

test("consent withdrawn after queueing suppresses the send", async () => {
  const { org, account } = await tenantWithNotifications();
  const { emailMessageId } = await notify(org, { ...message(), accountId: account }, { channels: ["email"] });
  await setPreferences(org, account, [{ category: "results", channel: "email", enabled: false }]);
  const provider = createFakeEmailProvider();
  await runJobs({ [EMAIL_JOB_KIND]: createEmailJobHandler(provider) }, { organizationIds: [org] });
  assert.equal(provider.sent.length, 0);
  assert.equal((await emailRow(emailMessageId!)).status, "suppressed");
});
