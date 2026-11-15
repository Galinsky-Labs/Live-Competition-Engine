import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import {
  createApplication, decideApplications, getApplicationForReview, listApplicationDecisions, listApplicationsForReview,
  saveApplicationForm, submitApplication, updateApplicationDraft, withdrawApplication
} from "./applications.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

const T0 = new Date("2026-03-01T12:00:00Z");
const formInput = (capacity: number | null = null) => ({
  opensAt: "2026-03-01T00:00:00Z",
  closesAt: "2026-03-08T00:00:00Z",
  capacity,
  contactConsentKey: "share_contact",
  fields: [
    { key: "bio", type: "text", label: "Bio", required: true, maxLength: 200 },
    { key: "sample", type: "media", label: "Sample", maxItems: 1 },
    { key: "rules", type: "consent", label: "Rules", required: true, consentVersion: "rules-v1" },
    { key: "share_contact", type: "consent", label: "Share contact", consentVersion: "contact-v1" }
  ]
});

async function setup(capacity: number | null = null) {
  const org = await createTenant();
  const producer = await createAccount(org);
  await enableFeature("applications", org, producer);
  const competition = await createCompetition(org);
  await saveApplicationForm(org, competition, producer, formInput(capacity), 0);
  return { org, producer, competition };
}

async function createMedia(org: string, owner: string): Promise<string> {
  const id = randomUUID();
  await getSqlClient()`INSERT INTO media_library (id, organization_id, owner_account_id) VALUES (${id}, ${org}, ${owner})`;
  return id;
}

async function submitted(org: string, competition: string, extra: Record<string, unknown> = {}) {
  const account = await createAccount(org);
  const { application } = await createApplication(org, competition, account, { displayName: "Entrant", answers: { bio: "Hello", rules: true, ...extra } }, T0);
  const result = await submitApplication(org, competition, application.id, account, application.revision, T0);
  return { account, application: result.application };
}

test("applicant drafts, edits, submits idempotently with consent and media; producer selects", async () => {
  const { org, producer, competition } = await setup();
  const applicant = await createAccount(org);
  const media = await createMedia(org, applicant);
  const first = await createApplication(org, competition, applicant, { displayName: "Ada", answers: { bio: "Draft" } }, T0);
  assert.equal(first.created, true);
  assert.equal(first.application.status, "draft");
  const again = await createApplication(org, competition, applicant, { displayName: "Ada" }, T0);
  assert.equal(again.created, false);
  assert.equal(again.application.id, first.application.id);

  // Drafts are private to the applicant.
  assert.equal((await listApplicationsForReview(org, competition)).length, 0);

  await assert.rejects(submitApplication(org, competition, first.application.id, applicant, 1, T0), { code: "application_incomplete" });
  const edited = await updateApplicationDraft(org, competition, first.application.id, applicant,
    { answers: { bio: "Final", sample: [media], rules: true, share_contact: true }, expectedRevision: 1 }, T0);
  assert.equal(edited.revision, 2);
  await assert.rejects(updateApplicationDraft(org, competition, first.application.id, applicant, { answers: { bio: "x" }, expectedRevision: 1 }, T0),
    { code: "application_revision_conflict" });

  const sub = await submitApplication(org, competition, first.application.id, applicant, 2, T0);
  assert.equal(sub.changed, true);
  assert.equal(sub.application.status, "submitted");
  const resub = await submitApplication(org, competition, first.application.id, applicant, 2, T0);
  assert.equal(resub.changed, false);
  assert.equal(resub.application.revision, sub.application.revision);
  await assert.rejects(updateApplicationDraft(org, competition, first.application.id, applicant, { answers: { bio: "late" }, expectedRevision: 3 }, T0),
    { code: "invalid_state_not_draft" });

  const review = await getApplicationForReview(org, competition, first.application.id);
  assert.deepEqual(review.consents.map(c => `${c.key}@${c.version}`).sort(), ["rules@rules-v1", "share_contact@contact-v1"]);
  assert.deepEqual(review.media, [{ fieldKey: "sample", mediaId: media }]);
  assert.equal(review.contactEmail, `fx-${applicant}@example.test`);

  const [selected] = await decideApplications(org, competition, producer, [{ applicationId: review.id, status: "selected", expectedRevision: review.revision }], T0);
  assert.equal(selected!.status, "selected");
  const [link] = await getSqlClient()<{ account_id: string; status: string; display_name: string }[]>`
    SELECT p.account_id, e.status, p.display_name FROM entries e JOIN participants p ON p.id = e.participant_id
    WHERE e.organization_id = ${org} AND e.id = ${selected!.entryId!}`;
  assert.deepEqual(link, { account_id: applicant, status: "approved", display_name: "Ada" });

  const history = await listApplicationDecisions(org, competition, review.id);
  assert.deepEqual(history.map(h => `${h.previousStatus}>${h.newStatus}:${h.actorKind}`), ["draft>submitted:applicant", "submitted>selected:producer"]);
  await assert.rejects(getSqlClient()`UPDATE application_decisions SET reason = 'x' WHERE application_id = ${review.id}`, /append-only/);
  await assert.rejects(getSqlClient()`DELETE FROM application_consents WHERE application_id = ${review.id}`, /append-only/);
  const audit = await getSqlClient()<{ action: string }[]>`SELECT action FROM audit_events WHERE chain_key = ${org} AND subject_id = ${review.id} ORDER BY sequence`;
  assert.deepEqual(audit.map(a => a.action), ["application.created", "application.submitted", "application.selected"]);
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("contact email stays hidden without the sharing consent", async () => {
  const { org, competition } = await setup();
  const { application } = await submitted(org, competition);
  assert.equal((await getApplicationForReview(org, competition, application.id)).contactEmail, null);
});

test("deadline and window are enforced server-side", async () => {
  const { org, competition } = await setup();
  const account = await createAccount(org);
  await assert.rejects(createApplication(org, competition, account, { displayName: "Early" }, new Date("2026-02-28T23:59:59Z")), { code: "application_window_not_open" });
  const { application } = await createApplication(org, competition, account, { displayName: "Ok", answers: { bio: "x", rules: true } }, T0);
  await assert.rejects(submitApplication(org, competition, application.id, account, 1, new Date("2026-03-08T00:00:00Z")), { code: "application_deadline_passed" });
  // Withdrawal is always possible.
  const withdrawn = await withdrawApplication(org, competition, application.id, account, { expectedRevision: 1 }, new Date("2026-04-01T00:00:00Z"));
  assert.equal(withdrawn.status, "withdrawn");
});

test("concurrent producer decisions: exactly one wins, the other conflicts", async () => {
  const { org, producer, competition } = await setup();
  const other = await createAccount(org);
  const { application } = await submitted(org, competition);
  const results = await Promise.allSettled([
    decideApplications(org, competition, producer, [{ applicationId: application.id, status: "selected", expectedRevision: application.revision }], T0),
    decideApplications(org, competition, other, [{ applicationId: application.id, status: "declined", reason: "Not a fit", expectedRevision: application.revision }], T0)
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "application_revision_conflict");
  assert.equal((await listApplicationDecisions(org, competition, application.id)).length, 2);
});

test("concurrent creates by one account produce a single active application", async () => {
  const { org, competition } = await setup();
  const account = await createAccount(org);
  const results = await Promise.all(Array.from({ length: 4 }, () => createApplication(org, competition, account, { displayName: "Racer" }, T0)));
  assert.equal(new Set(results.map(r => r.application.id)).size, 1);
  assert.equal(results.filter(r => r.created).length, 1);
});

test("capacity, waitlist ordering and automatic promotion on withdrawal", async () => {
  const { org, producer, competition } = await setup(1);
  const a = await submitted(org, competition);
  const b = await submitted(org, competition);
  const c = await submitted(org, competition);
  await decideApplications(org, competition, producer, [
    { applicationId: a.application.id, status: "selected", expectedRevision: a.application.revision },
    { applicationId: b.application.id, status: "waitlisted", expectedRevision: b.application.revision },
    { applicationId: c.application.id, status: "waitlisted", expectedRevision: c.application.revision }
  ], T0);
  const waitlist = await listApplicationsForReview(org, competition, { status: "waitlisted" });
  assert.deepEqual(waitlist.map(w => w.id), [b.application.id, c.application.id]);
  assert.ok(waitlist[0]!.waitlistPosition! < waitlist[1]!.waitlistPosition!);
  await assert.rejects(decideApplications(org, competition, producer, [{ applicationId: c.application.id, status: "selected", expectedRevision: waitlist[1]!.revision }], T0),
    { code: "selection_capacity_conflict" });
  // Declining requires a reason.
  await assert.rejects(decideApplications(org, competition, producer, [{ applicationId: c.application.id, status: "declined", expectedRevision: waitlist[1]!.revision }], T0),
    { code: "decision_reason_required" });

  const [aNow] = await listApplicationsForReview(org, competition, { status: "selected" });
  await withdrawApplication(org, competition, a.application.id, a.account, { expectedRevision: aNow!.revision, reason: "Schedule conflict" }, T0);
  const selected = await listApplicationsForReview(org, competition, { status: "selected" });
  assert.deepEqual(selected.map(s => s.id), [b.application.id]);
  assert.ok(selected[0]!.entryId);
  const [entry] = await getSqlClient()<{ status: string }[]>`SELECT status FROM entries WHERE id = ${aNow!.entryId!}`;
  assert.equal(entry!.status, "withdrawn");
  const promoted = await listApplicationDecisions(org, competition, b.application.id);
  assert.deepEqual(promoted.at(-1), { ...promoted.at(-1)!, actorKind: "system", reason: "waitlist_promotion", newStatus: "selected" });
  assert.deepEqual((await listApplicationsForReview(org, competition, { status: "waitlisted" })).map(w => w.id), [c.application.id]);
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("tenant isolation: another tenant cannot read, decide or reference media", async () => {
  const one = await setup();
  const two = await setup();
  const { application } = await submitted(one.org, one.competition);
  await assert.rejects(getApplicationForReview(two.org, one.competition, application.id), { code: "application_form_not_found" });
  await assert.rejects(decideApplications(two.org, two.competition, two.producer, [{ applicationId: application.id, status: "selected", expectedRevision: application.revision }], T0),
    { code: "application_not_found" });
  // Media owned by the same account id but in another tenant is not accepted.
  const applicant = await createAccount(two.org);
  const foreignMedia = await createMedia(one.org, one.producer);
  await assert.rejects(createApplication(two.org, two.competition, applicant, { displayName: "X", answers: { sample: [foreignMedia] } }, T0),
    { code: "application_media_not_found" });
  // Another member's media in the same tenant is also refused.
  const peerMedia = await createMedia(two.org, two.producer);
  await assert.rejects(createApplication(two.org, two.competition, applicant, { displayName: "X", answers: { sample: [peerMedia] } }, T0),
    { code: "application_media_not_found" });
});

test("applicants cannot touch other applicants' applications", async () => {
  const { org, competition } = await setup();
  const { application } = await submitted(org, competition);
  const intruder = await createAccount(org);
  await assert.rejects(withdrawApplication(org, competition, application.id, intruder, { expectedRevision: application.revision }, T0), { code: "application_not_found" });
});

test("the applications feature flag fails closed", async () => {
  const org = await createTenant();
  const producer = await createAccount(org);
  const competition = await createCompetition(org);
  await getSqlClient()`
    INSERT INTO feature_flags (scope_key, feature, scope, organization_id, enabled, revision, updated_by_account_id)
    VALUES (${`tenant:${org}`}, 'applications', 'tenant', ${org}, false, 1, ${producer})`;
  await assert.rejects(saveApplicationForm(org, competition, producer, formInput(), 0), { code: "feature_disabled" });
  const [count] = await getSqlClient()<{ n: number }[]>`SELECT count(*)::int AS n FROM application_forms WHERE organization_id = ${org}`;
  assert.equal(count!.n, 0);
});
