import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection } from "./index.ts";
import { createAccount, createCompetition, createEntry, createTenant } from "./test-fixtures.ts";
import { createCompetitionJudge, createRound } from "./judging-fixtures.ts";
import { assignJudgeToRound, setRoundLineup } from "./selection.ts";
import { declareConflict } from "./judges.ts";
import { activateRubric, createRubric, saveScoreSheet } from "./scoring.ts";
import { scoringJudgeStatusSource } from "./scoring-judge-status.ts";

after(closeDatabaseConnection);

test("control-room judge status reflects panel, recusals and submitted sheets only", async () => {
  const org = await createTenant();
  const producer = await createAccount(org);
  const competition = await createCompetition(org);
  const round = await createRound(org, competition);
  const a = await createEntry(org, competition, "Alpha");
  const lineup = await setRoundLineup(org, competition, round, producer, { entryIds: [a.entryId], expectedRevision: 0 });
  const rubric = await createRubric(org, competition, producer, {
    criteria: [{ key: "overall", label: "Overall", min: 0, max: 10, step: 1 }],
    aggregation: { method: "weighted_mean" }
  });
  await activateRubric(org, competition, producer, rubric.id);
  const judges: Array<{ account: string; judgeId: string }> = [];
  for (const name of ["A judge", "B judge", "C judge"]) {
    const account = await createAccount(org);
    const judgeId = await createCompetitionJudge(org, competition, { accountId: account, actorAccountId: producer, name });
    judges.push({ account, judgeId });
  }
  // C is attached to the competition but not on this round's panel.
  for (const judge of judges.slice(0, 2)) await assignJudgeToRound(org, competition, round, producer, { judgeId: judge.judgeId, role: "panelist" });
  const performance = lineup.slots[0]!.performanceId;

  let report = await scoringJudgeStatusSource.forPerformance(org, competition, performance);
  assert.equal(report.status, "known");
  assert.deepEqual(report.judges.map(j => [j.displayName, j.submitted]), [["A judge", false], ["B judge", false]]);

  await saveScoreSheet(org, competition, judges[0]!.account, round, performance, { values: { overall: 7 }, submit: false });
  report = await scoringJudgeStatusSource.forPerformance(org, competition, performance);
  assert.equal(report.judges[0]!.submitted, false, "drafts do not count as submitted");

  await saveScoreSheet(org, competition, judges[0]!.account, round, performance, { values: { overall: 7 }, submit: true, expectedRevision: 1 });
  await declareConflict(org, competition, judges[1]!.account, { entryId: a.entryId, reason: "Relative" });
  report = await scoringJudgeStatusSource.forPerformance(org, competition, performance);
  assert.deepEqual(report.judges.map(j => [j.displayName, j.submitted]), [["A judge", true]]);

  const other = await createTenant();
  await assert.rejects(scoringJudgeStatusSource.forPerformance(other, competition, performance), { code: "performance_not_found" });
  await assert.rejects(scoringJudgeStatusSource.forPerformance(org, competition, randomUUID()), { code: "performance_not_found" });
});
