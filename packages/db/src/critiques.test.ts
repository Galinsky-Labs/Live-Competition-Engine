import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import { createCompetitionJudge, createRound } from "./judging-fixtures.ts";
import { assignJudgeToRound, setRoundLineup } from "./selection.ts";
import { declareConflict } from "./judges.ts";
import {
  fileAppeal, listAppeals, listCritiquesForModeration, listEntrantCritiques, listJudgeCritiques, listPublicCritiques,
  moderateCritique, resolveAppeal, retractCritique, saveCritiqueDraft, submitCritique, withdrawAppeal, withdrawCritique
} from "./critiques.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

async function entrantEntry(org: string, competition: string, name: string) {
  const sql = getSqlClient();
  const account = await createAccount(org);
  const participant = randomUUID();
  const entry = randomUUID();
  await sql`INSERT INTO participants (id, organization_id, display_name, account_id) VALUES (${participant}, ${org}, ${name}, ${account})`;
  await sql`INSERT INTO entries (id, organization_id, competition_id, participant_id, status) VALUES (${entry}, ${org}, ${competition}, ${participant}, 'approved')`;
  return { account, entry };
}

async function setup() {
  const org = await createTenant();
  const producer = await createAccount(org);
  const otherProducer = await createAccount(org);
  await enableFeature("critiques", org, producer);
  const competition = await createCompetition(org);
  await getSqlClient()`UPDATE competitions SET status = 'published' WHERE id = ${competition}`;
  const round = await createRound(org, competition);
  const a = await entrantEntry(org, competition, "Alpha");
  const b = await entrantEntry(org, competition, "Beta");
  const lineup = await setRoundLineup(org, competition, round, producer, { entryIds: [a.entry, b.entry], expectedRevision: 0 });
  const judge = await createAccount(org);
  const judgeId = await createCompetitionJudge(org, competition, { accountId: judge, actorAccountId: producer });
  await assignJudgeToRound(org, competition, round, producer, { judgeId });
  const [pa, pb] = lineup.slots.map(s => s.performanceId) as [string, string];
  return { org, producer, otherProducer, competition, round, a, b, pa, pb, judge, judgeId };
}

test("private critiques are delivered straight to the entrant and never published", async () => {
  const s = await setup();
  const draft = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "Clear structure.", visibility: "private" });
  assert.equal((await listEntrantCritiques(s.org, s.competition, s.a.account)).length, 0, "drafts are invisible to entrants");
  const edited = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "Clear structure; pace the ending.", visibility: "private", expectedRevision: 1 });
  await assert.rejects(saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "x", visibility: "private", expectedRevision: 1 }), { code: "critique_revision_conflict" });
  const delivered = await submitCritique(s.org, s.competition, s.judge, draft.id, edited.revision);
  assert.equal(delivered.status, "delivered");
  await assert.rejects(saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "late", visibility: "private", expectedRevision: delivered.revision }), { code: "critique_locked_conflict" });
  const mine = await listEntrantCritiques(s.org, s.competition, s.a.account);
  assert.deepEqual(mine.map(c => [c.body, c.visibility]), [["Clear structure; pace the ending.", "private"]]);
  assert.ok(!("judgeId" in mine[0]!), "judge identity is not disclosed to entrants");
  assert.equal((await listEntrantCritiques(s.org, s.competition, s.b.account)).length, 0);
  assert.equal((await listPublicCritiques(s.org, s.competition)).length, 0);
  assert.equal((await listJudgeCritiques(s.org, s.competition, s.judge)).length, 1);
});

test("public critiques need moderation; rejection returns to the judge; publication is public", async () => {
  const s = await setup();
  const draft = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pb, { body: "Bold choices.", visibility: "public" });
  let c = await submitCritique(s.org, s.competition, s.judge, draft.id, draft.revision);
  assert.equal(c.status, "pending_moderation");
  assert.equal((await listEntrantCritiques(s.org, s.competition, s.b.account)).length, 0);
  assert.deepEqual((await listCritiquesForModeration(s.org, s.competition)).map(x => [x.id, x.entrantName]), [[c.id, "Beta"]]);
  await assert.rejects(moderateCritique(s.org, s.competition, s.judge, c.id, { decision: "published", expectedRevision: c.revision }), { code: "self_approval_forbidden" });
  await assert.rejects(moderateCritique(s.org, s.competition, s.producer, c.id, { decision: "rejected", expectedRevision: c.revision }), { code: "decision_reason_required" });
  c = await moderateCritique(s.org, s.competition, s.producer, c.id, { decision: "rejected", reason: "Names a third party", expectedRevision: c.revision });
  assert.equal(c.moderationReason, "Names a third party");
  c = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pb, { body: "Bold choices throughout.", visibility: "public", expectedRevision: c.revision });
  assert.equal(c.status, "draft");
  c = await submitCritique(s.org, s.competition, s.judge, c.id, c.revision);
  c = await moderateCritique(s.org, s.competition, s.producer, c.id, { decision: "published", expectedRevision: c.revision });
  assert.equal(c.status, "published");
  assert.deepEqual((await listPublicCritiques(s.org, s.competition)).map(x => [x.entrantName, x.body]), [["Beta", "Bold choices throughout."]]);
  assert.equal((await listEntrantCritiques(s.org, s.competition, s.b.account)).length, 1);
  const trail = await getSqlClient()<{ to_status: string }[]>`SELECT to_status FROM critique_events WHERE critique_id = ${c.id} ORDER BY id`;
  assert.deepEqual(trail.map(t => t.to_status), ["draft", "pending_moderation", "rejected", "draft", "pending_moderation", "published"]);
  await assert.rejects(getSqlClient()`DELETE FROM critique_events WHERE critique_id = ${c.id}`, /append-only/);
  // Draft competitions expose nothing publicly.
  await getSqlClient()`UPDATE competitions SET status = 'draft' WHERE id = ${s.competition}`;
  assert.equal((await listPublicCritiques(s.org, s.competition)).length, 0);
});

test("two producers moderating the same critique: one wins", async () => {
  const s = await setup();
  const draft = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "Good.", visibility: "public" });
  const c = await submitCritique(s.org, s.competition, s.judge, draft.id, draft.revision);
  const results = await Promise.allSettled([
    moderateCritique(s.org, s.competition, s.producer, c.id, { decision: "published", expectedRevision: c.revision }),
    moderateCritique(s.org, s.competition, s.otherProducer, c.id, { decision: "rejected", reason: "No", expectedRevision: c.revision })
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "critique_revision_conflict");
});

test("appeals: entrant files, producer reviews and upholds with retraction; full trail", async () => {
  const s = await setup();
  const draft = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "Wrong piece referenced.", visibility: "private" });
  const c = await submitCritique(s.org, s.competition, s.judge, draft.id, draft.revision);
  await assert.rejects(fileAppeal(s.org, s.competition, s.b.account, c.id, { kind: "appeal", body: "Not mine" }), { code: "critique_not_found" });
  const appeal = await fileAppeal(s.org, s.competition, s.a.account, c.id, { kind: "correction", body: "This refers to another performance." });
  await assert.rejects(fileAppeal(s.org, s.competition, s.a.account, c.id, { kind: "appeal", body: "Again" }), { code: "appeal_pending_conflict" });
  await assert.rejects(resolveAppeal(s.org, s.competition, s.judge, appeal.id, { status: "dismissed", reason: "Mine is right", expectedRevision: 1 }), { code: "self_approval_forbidden" });
  const reviewing = await resolveAppeal(s.org, s.competition, s.producer, appeal.id, { status: "under_review", expectedRevision: 1 });
  await assert.rejects(resolveAppeal(s.org, s.competition, s.producer, appeal.id, { status: "upheld", expectedRevision: reviewing.revision }), { code: "decision_reason_required" });
  await assert.rejects(resolveAppeal(s.org, s.competition, s.producer, appeal.id, { status: "upheld", reason: "x", expectedRevision: 1 }), { code: "appeal_revision_conflict" });
  const upheld = await resolveAppeal(s.org, s.competition, s.producer, appeal.id, { status: "upheld", reason: "Confirmed mix-up", retract: true, expectedRevision: reviewing.revision });
  assert.deepEqual(upheld.trail.map(t => `${t.actorKind}:${t.toStatus}`), ["entrant:open", "producer:under_review", "producer:upheld"]);
  assert.equal((await listEntrantCritiques(s.org, s.competition, s.a.account)).length, 0, "retracted critique is no longer shown");
  assert.equal((await listAppeals(s.org, s.competition, { status: "upheld" }))[0]!.critiqueStatus, "retracted");
  // A retracted critique frees the slot for a fresh critique.
  const fresh = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "Corrected feedback.", visibility: "private" });
  assert.equal(fresh.status, "draft");
  assert.equal((await verifyAuditChain(s.org)).valid, true);
});

test("entrants can withdraw appeals; producers can retract published critiques", async () => {
  const s = await setup();
  const d = await saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pb, { body: "Fine.", visibility: "public" });
  let c = await submitCritique(s.org, s.competition, s.judge, d.id, d.revision);
  c = await moderateCritique(s.org, s.competition, s.producer, c.id, { decision: "published", expectedRevision: c.revision });
  const appeal = await fileAppeal(s.org, s.competition, s.b.account, c.id, { kind: "appeal", body: "Too harsh" });
  const withdrawn = await withdrawAppeal(s.org, s.competition, s.b.account, appeal.id, 1);
  assert.equal(withdrawn.status, "withdrawn");
  await assert.rejects(withdrawAppeal(s.org, s.competition, s.a.account, appeal.id, 2), { code: "appeal_not_found" });
  c = await retractCritique(s.org, s.competition, s.producer, c.id, { reason: "Published in error", expectedRevision: c.revision });
  assert.equal(c.status, "retracted");
  await assert.rejects(withdrawCritique(s.org, s.competition, s.judge, c.id, c.revision), { code: "invalid_state_transition" });
});

test("recused judges cannot critique; the feature flag and tenant boundaries fail closed", async () => {
  const s = await setup();
  await declareConflict(s.org, s.competition, s.judge, { entryId: s.a.entry, reason: "Cousin" });
  await assert.rejects(saveCritiqueDraft(s.org, s.competition, s.judge, s.round, s.pa, { body: "x", visibility: "private" }), { code: "judge_recused" });
  const other = await setup();
  await assert.rejects(saveCritiqueDraft(other.org, other.competition, s.judge, s.round, s.pb, { body: "x", visibility: "private" }), { code: "forbidden" });
  await assert.rejects(saveCritiqueDraft(other.org, other.competition, other.judge, s.round, s.pb, { body: "x", visibility: "private" }), { code: "performance_not_found" });
  await assert.rejects(listCritiquesForModeration(other.org, s.competition), { code: "forbidden" });
  await assert.rejects(listEntrantCritiques(other.org, other.competition, s.a.account), { code: "forbidden" });
  assert.equal((await listEntrantCritiques(other.org, other.competition, other.a.account)).length, 0);

  const org = await createTenant();
  const producer = await createAccount(org);
  const competition = await createCompetition(org);
  await getSqlClient()`INSERT INTO feature_flags (scope_key, feature, scope, organization_id, enabled, revision, updated_by_account_id)
    VALUES (${`tenant:${org}`}, 'critiques', 'tenant', ${org}, false, 1, ${producer})`;
  await assert.rejects(listPublicCritiques(org, competition), { code: "feature_disabled" });
  await assert.rejects(listCritiquesForModeration(org, competition), { code: "feature_disabled" });
});
