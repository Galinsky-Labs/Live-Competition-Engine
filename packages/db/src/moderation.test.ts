import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection } from "./index.ts";
import { createAccount, createTenant } from "./test-fixtures.ts";
import { listAuditEvents } from "./audit.ts";
import { consumeRateLimit } from "./rate-limit.ts";
import {
  addEvidence,
  decideAppeal,
  deleteReport,
  fileAppeal,
  getReport,
  isSubjectHidden,
  isUnderLegalHold,
  listReports,
  moderationOverviewCounts,
  placeLegalHold,
  releaseLegalHold,
  submitReport,
  takeModerationAction,
  transitionReport
} from "./moderation.ts";

after(closeDatabaseConnection);

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return "no_error";
};

test("report lifecycle: submit, dedupe, triage, action with hide, appeal overturned", async () => {
  const org = await createTenant();
  const operator = await createAccount(org);
  const reporter = await createAccount(org);
  const author = await createAccount(org);
  const subjectId = randomUUID();
  const first = await submitReport(org, { accountId: reporter }, { subjectType: "chat_message", subjectId, reason: "harassment" });
  const again = await submitReport(org, { accountId: reporter }, { subjectType: "chat_message", subjectId, reason: "harassment" });
  assert.equal(again.duplicate, true);
  assert.equal(again.report.id, first.report.id);

  const triaged = await transitionReport(org, operator, first.report.id, { to: "triaged", expectedRevision: 1 });
  assert.equal(triaged.status, "triaged");
  assert.equal(await code(transitionReport(org, operator, first.report.id, { to: "dismissed", expectedRevision: 1 })), "report_revision_conflict");
  assert.equal(await code(transitionReport(org, operator, first.report.id, { to: "open", expectedRevision: 2 })), "invalid_state_report_transition");

  assert.equal(await isSubjectHidden(org, "chat_message", subjectId), false);
  const action = await takeModerationAction(org, operator, {
    subjectType: "chat_message", subjectId, action: "hide", reason: "abusive", reportId: first.report.id, affectedAccountId: author
  });
  assert.equal(await isSubjectHidden(org, "chat_message", subjectId), true);
  assert.equal((await getReport(org, first.report.id))?.status, "actioned");

  assert.equal(await code(fileAppeal(org, reporter, action.id, "not me")), "action_not_found");
  const appeal = await fileAppeal(org, author, action.id, "It was a quote from the performance.");
  assert.equal(await code(fileAppeal(org, author, action.id, "again")), "appeal_conflict");
  await decideAppeal(org, operator, appeal.id, { decision: "overturned", note: "context accepted" });
  assert.equal(await isSubjectHidden(org, "chat_message", subjectId), false);
  assert.equal(await code(decideAppeal(org, operator, appeal.id, { decision: "upheld" })), "invalid_state_appeal_decided");

  const audit = await listAuditEvents(org, { limit: 50 });
  const actions = audit.map(row => row.action);
  for (const expected of ["moderation.report_submitted", "moderation.report_triaged", "moderation.report_actioned", "moderation.hide",
    "moderation.appeal_filed", "moderation.appeal_overturned", "moderation.action_reversed"]) {
    assert.ok(actions.includes(expected), expected);
  }
  const report = await getReport(org, first.report.id);
  assert.deepEqual(report?.history.map(row => row.to_status), ["triaged", "actioned"]);
});

test("anonymous reports are rate limited per reporter key", async () => {
  const org = await createTenant();
  const anonymousKey = `ip-${randomUUID()}`;
  for (let i = 0; i < 5; i += 1) {
    await submitReport(org, { anonymousKey }, { subjectType: "page", subjectId: `p-${i}`, reason: "spam" });
  }
  assert.equal(await code(submitReport(org, { anonymousKey }, { subjectType: "page", subjectId: "p-9", reason: "spam" })), "rate_limited");
  await submitReport(org, { anonymousKey: `${anonymousKey}-other` }, { subjectType: "page", subjectId: "p-9", reason: "spam" });
});

test("rate limiter never exceeds its limit under concurrency", async () => {
  const key = `test:${randomUUID()}`;
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeRateLimit(key, 5, 60_000)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 5);
});

test("legal hold blocks deletion of moderation records until released", async () => {
  const org = await createTenant();
  const operator = await createAccount(org);
  const subjectId = randomUUID();
  const { report } = await submitReport(org, { accountId: operator }, { subjectType: "profile", subjectId, reason: "impersonation" });
  await addEvidence(org, operator, report.id, { kind: "text", body: "Screenshot transcript" });
  await transitionReport(org, operator, report.id, { to: "dismissed", expectedRevision: 1 });
  const hold = await placeLegalHold(org, operator, { subjectType: "profile", subjectId, reason: "subpoena 42" });
  assert.equal(await isUnderLegalHold(org, "profile", subjectId), true);
  assert.equal(await code(placeLegalHold(org, operator, { subjectType: "profile", subjectId, reason: "dup" })), "legal_hold_conflict");
  assert.equal(await code(deleteReport(org, operator, report.id)), "legal_hold_active");
  await releaseLegalHold(org, operator, hold.id);
  await deleteReport(org, operator, report.id);
  assert.equal(await getReport(org, report.id), null);
});

test("cross-tenant access is refused for reports, actions, evidence and holds", async () => {
  const org = await createTenant();
  const otherOrg = await createTenant();
  const operator = await createAccount(org);
  const otherOperator = await createAccount(otherOrg);
  const subjectId = randomUUID();
  const { report } = await submitReport(org, { accountId: operator }, { subjectType: "media", subjectId, reason: "copyright" });
  assert.equal(await code(transitionReport(otherOrg, otherOperator, report.id, { to: "triaged", expectedRevision: 1 })), "report_not_found");
  assert.equal(await code(addEvidence(otherOrg, otherOperator, report.id, { kind: "text", body: "x" })), "report_not_found");
  assert.equal(await code(takeModerationAction(otherOrg, otherOperator, { subjectType: "media", subjectId, action: "takedown", reason: "x", reportId: report.id })), "report_not_found");
  await takeModerationAction(org, operator, { subjectType: "media", subjectId, action: "takedown", reason: "dmca" });
  assert.equal(await isSubjectHidden(otherOrg, "media", subjectId), false);
  assert.equal((await listReports(otherOrg)).length, 0);
  assert.equal(await code(addEvidence(org, operator, report.id, { kind: "media", mediaId: randomUUID() })), "media_not_found");
  const counts = await moderationOverviewCounts(org);
  assert.equal(counts.reports.open, 1);
  assert.equal(counts.activeActions, 1);
});
