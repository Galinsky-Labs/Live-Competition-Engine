import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createEntry, createTenant } from "./test-fixtures.ts";
import { createCompetitionJudge, createRound } from "./judging-fixtures.ts";
import { assignJudgeToRound, setRoundLineup } from "./selection.ts";
import { declareConflict } from "./judges.ts";
import {
  activateRubric, createRubric, decideCorrection, getOwnScoreSheet, getStandings, listCorrections, listRubrics,
  requestScoreCorrection, saveScoreSheet
} from "./scoring.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

const definition = {
  criteria: [
    { key: "craft", label: "Craft", min: 0, max: 10, step: 0.5, weight: 2 },
    { key: "impact", label: "Impact", min: 0, max: 10, step: 1 }
  ],
  aggregation: { method: "weighted_mean" },
  tieBreakers: [{ type: "head_judge" }]
};

async function setup() {
  const org = await createTenant();
  const producer = await createAccount(org);
  const competition = await createCompetition(org);
  const round = await createRound(org, competition);
  const [a, b] = [await createEntry(org, competition, "Alpha"), await createEntry(org, competition, "Beta")];
  const lineup = await setRoundLineup(org, competition, round, producer, { entryIds: [a.entryId, b.entryId], expectedRevision: 0 });
  const rubric = await createRubric(org, competition, producer, definition);
  await activateRubric(org, competition, producer, rubric.id);
  const judges = [];
  for (const [i, role] of (["head", "panelist"] as const).entries()) {
    const account = await createAccount(org);
    const judgeId = await createCompetitionJudge(org, competition, { accountId: account, actorAccountId: producer, name: `Judge ${i}` });
    await assignJudgeToRound(org, competition, round, producer, { judgeId, role });
    judges.push({ account, judgeId });
  }
  const [pa, pb] = lineup.slots.map(s => s.performanceId) as [string, string];
  return { org, producer, competition, round, a: a.entryId, b: b.entryId, pa, pb, judges, rubric };
}

test("draft → submit is idempotent; submitted sheets are immutable even to direct SQL", async () => {
  const s = await setup();
  const j = s.judges[1]!.account;
  const draft = await saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 6 }, submit: false });
  assert.equal(draft.sheet.status, "draft");
  await assert.rejects(saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 6 }, submit: true, expectedRevision: 1 }), { code: "score_incomplete" });
  await assert.rejects(saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 6, impact: 4 }, submit: true, expectedRevision: 9 }), { code: "score_revision_conflict" });
  const submitted = await saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 6, impact: 4 }, submit: true, expectedRevision: 1 });
  assert.equal(submitted.sheet.status, "submitted");
  const again = await saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 6, impact: 4 }, submit: true });
  assert.equal(again.changed, false);
  await assert.rejects(saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 7, impact: 4 }, submit: true }), { code: "score_immutable_conflict" });
  await assert.rejects(saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 7 }, submit: false, expectedRevision: 2 }), { code: "score_immutable_conflict" });
  await assert.rejects(saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 6.25, impact: 4 }, submit: false }), { code: "invalid_score_values" });
  const sql = getSqlClient();
  await assert.rejects(sql`UPDATE score_sheets SET score_values = '{"craft":10,"impact":10}' WHERE id = ${submitted.sheet.id}`, /immutable/);
  await assert.rejects(sql`DELETE FROM score_sheets WHERE id = ${submitted.sheet.id}`, /immutable/);
  const own = await getOwnScoreSheet(s.org, s.competition, j, s.round, s.pa);
  assert.deepEqual(own.sheet!.values, { craft: 6, impact: 4 });
  // The active rubric cannot be swapped once scores exist.
  const v2 = await createRubric(s.org, s.competition, s.producer, definition);
  await assert.rejects(activateRubric(s.org, s.competition, s.producer, v2.id), { code: "invalid_state_scores_exist" });
  await assert.rejects(sql`UPDATE scoring_rubrics SET definition = '{}' WHERE id = ${s.rubric.id}`, /immutable/);
  assert.deepEqual((await listRubrics(s.org, s.competition)).map(r => [r.version, r.status]), [[2, "draft"], [1, "active"]]);
});

test("access rules: panel membership, recusal and verification are enforced for scoring", async () => {
  const s = await setup();
  const outsider = await createAccount(s.org);
  const offPanel = await createCompetitionJudge(s.org, s.competition, { accountId: outsider, actorAccountId: s.producer });
  assert.ok(offPanel);
  await assert.rejects(saveScoreSheet(s.org, s.competition, outsider, s.round, s.pa, { values: {}, submit: false }), { code: "performance_not_found" });
  const j = s.judges[0]!.account;
  await declareConflict(s.org, s.competition, j, { entryId: s.b, reason: "Relative" });
  await assert.rejects(saveScoreSheet(s.org, s.competition, j, s.round, s.pb, { values: {}, submit: false }), { code: "judge_recused" });
  await getSqlClient()`UPDATE competition_judge_states SET status = 'active', verified_at = NULL, verified_by_account_id = NULL WHERE judge_id = ${s.judges[1]!.judgeId}`;
  await assert.rejects(saveScoreSheet(s.org, s.competition, s.judges[1]!.account, s.round, s.pa, { values: {}, submit: false }), { code: "judge_not_verified" });
  const stranger = await createAccount(s.org);
  await assert.rejects(saveScoreSheet(s.org, s.competition, stranger, s.round, s.pa, { values: {}, submit: false }), { code: "judge_not_found" });
});

test("concurrent first saves by one judge: one succeeds, the other conflicts", async () => {
  const s = await setup();
  const j = s.judges[1]!.account;
  const results = await Promise.allSettled([1, 2].map(n => saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: n }, submit: false })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "score_revision_conflict");
});

test("corrections create a superseding sheet only after approval by someone else; standings follow", async () => {
  const s = await setup();
  const [head, panelist] = [s.judges[0]!, s.judges[1]!];
  // Equal averages (a: (2*6+3)/3=5 & 5 → 5; b: 5 & 5); the head judge prefers Beta.
  await saveScoreSheet(s.org, s.competition, head.account, s.round, s.pa, { values: { craft: 4, impact: 4 }, submit: true });
  await saveScoreSheet(s.org, s.competition, head.account, s.round, s.pb, { values: { craft: 6, impact: 6 }, submit: true });
  const wrong = await saveScoreSheet(s.org, s.competition, panelist.account, s.round, s.pa, { values: { craft: 6, impact: 6 }, submit: true });
  await saveScoreSheet(s.org, s.competition, panelist.account, s.round, s.pb, { values: { craft: 4, impact: 4 }, submit: true });
  let standings = await getStandings(s.org, s.competition, { roundId: s.round });
  assert.deepEqual(standings.standings.map(x => [x.displayName, x.rank, x.score, x.tieBreak]), [["Beta", 1, 5, "head_judge"], ["Alpha", 2, 5, "head_judge"]]);

  await assert.rejects(requestScoreCorrection(s.org, s.competition, panelist.account, { sheetId: wrong.sheet.id, values: { craft: 6, impact: 6 }, reason: "same" }), { code: "correction_unchanged" });
  await assert.rejects(requestScoreCorrection(s.org, s.competition, head.account, { sheetId: wrong.sheet.id, values: { craft: 9, impact: 9 }, reason: "not mine" }), { code: "score_sheet_not_found" });
  const correction = await requestScoreCorrection(s.org, s.competition, panelist.account, { sheetId: wrong.sheet.id, values: { craft: 9, impact: 9 }, reason: "Typed into the wrong row" });
  await assert.rejects(requestScoreCorrection(s.org, s.competition, panelist.account, { sheetId: wrong.sheet.id, values: { craft: 8, impact: 8 }, reason: "again" }), { code: "correction_pending_conflict" });
  // The original remains effective until approval.
  assert.equal((await getStandings(s.org, s.competition)).standings[0]!.displayName, "Beta");
  await assert.rejects(decideCorrection(s.org, s.competition, panelist.account, correction.id, { decision: "approved", expectedRevision: 1 }), { code: "self_approval_forbidden" });
  await assert.rejects(decideCorrection(s.org, s.competition, s.producer, correction.id, { decision: "approved", expectedRevision: 5 }), { code: "correction_revision_conflict" });
  const approved = await decideCorrection(s.org, s.competition, s.producer, correction.id, { decision: "approved", reason: "Verified with the judge", expectedRevision: 1 });
  assert.equal(approved.status, "approved");
  await assert.rejects(decideCorrection(s.org, s.competition, s.producer, correction.id, { decision: "rejected", reason: "x", expectedRevision: 2 }), { code: "invalid_state_correction_decided" });
  const sheets = await getSqlClient()<{ id: string; status: string; supersedes_sheet_id: string | null }[]>`
    SELECT id, status, supersedes_sheet_id FROM score_sheets WHERE performance_id = ${s.pa} AND judge_id = ${s.judges[1]!.judgeId} ORDER BY created_at`;
  assert.deepEqual(sheets.map(x => x.status), ["superseded", "submitted"]);
  assert.equal(sheets[1]!.supersedes_sheet_id, wrong.sheet.id);
  standings = await getStandings(s.org, s.competition, { roundId: s.round });
  assert.deepEqual(standings.standings.map(x => [x.displayName, x.rank]), [["Alpha", 1], ["Beta", 2]]);
  assert.equal((await listCorrections(s.org, s.competition, { status: "approved" })).length, 1);
  const audit = await getSqlClient()<{ action: string }[]>`SELECT action FROM audit_events WHERE chain_key = ${s.org} AND action LIKE 'score.%' ORDER BY sequence`;
  assert.deepEqual(audit.map(x => x.action).slice(-2), ["score.correction_requested", "score.correction_approved"]);
  assert.equal((await verifyAuditChain(s.org)).valid, true);
});

test("rejected corrections leave the original in force", async () => {
  const s = await setup();
  const j = s.judges[1]!.account;
  const sheet = await saveScoreSheet(s.org, s.competition, j, s.round, s.pa, { values: { craft: 5, impact: 5 }, submit: true });
  const c = await requestScoreCorrection(s.org, s.competition, j, { sheetId: sheet.sheet.id, values: { craft: 9, impact: 9 }, reason: "Second thoughts" });
  await assert.rejects(decideCorrection(s.org, s.competition, s.producer, c.id, { decision: "rejected", expectedRevision: 1 }), { code: "decision_reason_required" });
  await decideCorrection(s.org, s.competition, s.producer, c.id, { decision: "rejected", reason: "Scores are final", expectedRevision: 1 });
  assert.deepEqual((await getOwnScoreSheet(s.org, s.competition, j, s.round, s.pa)).sheet!.values, { craft: 5, impact: 5 });
});

test("tenant isolation for rubrics, sheets and standings", async () => {
  const one = await setup();
  const two = await setup();
  await assert.rejects(getStandings(two.org, one.competition), { code: "rubric_not_found" });
  await assert.rejects(saveScoreSheet(two.org, one.competition, one.judges[0]!.account, one.round, one.pa, { values: {}, submit: false }), { code: "judge_not_found" });
  await assert.rejects(saveScoreSheet(two.org, two.competition, two.judges[0]!.account, one.round, one.pa, { values: {}, submit: false }), { code: "performance_not_found" });
  await assert.rejects(activateRubric(two.org, two.competition, two.producer, one.rubric.id), { code: "rubric_not_found" });
  await assert.rejects(createRubric(two.org, one.competition, two.producer, definition), { code: "competition_not_found" });
});
