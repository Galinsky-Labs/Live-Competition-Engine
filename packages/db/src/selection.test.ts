import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createEntry, createTenant } from "./test-fixtures.ts";
import { createCompetitionJudge, createRound } from "./judging-fixtures.ts";
import {
  assignJudgeToRound, getRoundLineup, getRoundPanel, getSelectionSummary, listLineupHistory, removeJudgeFromRound, setRoundLineup
} from "./selection.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

async function setup() {
  const org = await createTenant();
  const producer = await createAccount(org);
  const competition = await createCompetition(org);
  const round = await createRound(org, competition, 1);
  const entries = await Promise.all([1, 2, 3].map(n => createEntry(org, competition, `Entrant ${n}`)));
  return { org, producer, competition, round, entries: entries.map(e => e.entryId) };
}

test("lineup is created, reordered with revisions and versioned history", async () => {
  const { org, producer, competition, round, entries: [a, b, c] } = await setup();
  const first = await setRoundLineup(org, competition, round, producer, { entryIds: [a, b], expectedRevision: 0 });
  assert.equal(first.revision, 1);
  assert.deepEqual(first.slots.map(s => [s.entryId, s.ordinal]), [[a, 1], [b, 2]]);
  const keepId = first.slots[1]!.performanceId;
  const second = await setRoundLineup(org, competition, round, producer, { entryIds: [b, c], expectedRevision: 1, reason: "Swap" });
  assert.deepEqual(second.slots.map(s => [s.entryId, s.ordinal]), [[b!, 1], [c!, 2]]);
  assert.equal(second.slots[0]!.performanceId, keepId, "moved slots keep their performance row");
  await assert.rejects(setRoundLineup(org, competition, round, producer, { entryIds: [a], expectedRevision: 1 }), { code: "lineup_revision_conflict" });
  const history = await listLineupHistory(org, competition, round);
  assert.deepEqual(history.map(h => h.revision), [1, 2]);
  assert.equal(history[1]!.reason, "Swap");
  await assert.rejects(getSqlClient()`DELETE FROM round_lineup_history WHERE round_id = ${round}`, /append-only/);
  assert.equal((await getRoundLineup(org, competition, round)).revision, 2);
  const summary = await getSelectionSummary(org, competition);
  assert.deepEqual(summary.rounds.map(r => r.lineupRevision), [2]);
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("two producers editing one lineup: exactly one wins", async () => {
  const { org, producer, competition, round, entries: [a, b] } = await setup();
  const other = await createAccount(org);
  const results = await Promise.allSettled([
    setRoundLineup(org, competition, round, producer, { entryIds: [a, b], expectedRevision: 0 }),
    setRoundLineup(org, competition, round, other, { entryIds: [b, a], expectedRevision: 0 })
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code, "lineup_revision_conflict");
});

test("only approved entries of this competition can be slotted; started slots are locked", async () => {
  const { org, producer, competition, round, entries: [a, b] } = await setup();
  const otherCompetition = await createCompetition(org);
  const foreign = await createEntry(org, otherCompetition);
  await assert.rejects(setRoundLineup(org, competition, round, producer, { entryIds: [a, foreign.entryId], expectedRevision: 0 }), { code: "entry_not_eligible" });
  await getSqlClient()`UPDATE entries SET status = 'withdrawn' WHERE id = ${b!}`;
  await assert.rejects(setRoundLineup(org, competition, round, producer, { entryIds: [b], expectedRevision: 0 }), { code: "entry_not_eligible" });
  const lineup = await setRoundLineup(org, competition, round, producer, { entryIds: [a], expectedRevision: 0 });
  await getSqlClient()`UPDATE performances SET status = 'completed' WHERE id = ${lineup.slots[0]!.performanceId}`;
  await assert.rejects(setRoundLineup(org, competition, round, producer, { entryIds: [], expectedRevision: 1 }), { code: "invalid_state_performance_started" });
  await getSqlClient()`UPDATE rounds SET status = 'completed' WHERE id = ${round}`;
  await assert.rejects(setRoundLineup(org, competition, round, producer, { entryIds: [a], expectedRevision: 1 }), { code: "invalid_state_round_closed" });
});

test("judge panels: assign, idempotent, head conflict, role change, removal, eligibility", async () => {
  const { org, producer, competition, round } = await setup();
  const j1 = await createCompetitionJudge(org, competition, { actorAccountId: producer, name: "A" });
  const j2 = await createCompetitionJudge(org, competition, { actorAccountId: producer, name: "B" });
  const suspended = await createCompetitionJudge(org, competition, { actorAccountId: producer, status: "suspended", name: "C" });
  let panel = await assignJudgeToRound(org, competition, round, producer, { judgeId: j1, role: "head" });
  assert.deepEqual(panel.assigned.map(a => [a.judgeId, a.role]), [[j1, "head"]]);
  assert.deepEqual(panel.available.map(a => a.judgeId).sort(), [j1, j2].sort(), "suspended judges are not offered");
  panel = await assignJudgeToRound(org, competition, round, producer, { judgeId: j1, role: "head" });
  assert.equal(panel.assigned.length, 1);
  await assert.rejects(assignJudgeToRound(org, competition, round, producer, { judgeId: j2, role: "head" }), { code: "panel_head_conflict" });
  await assert.rejects(assignJudgeToRound(org, competition, round, producer, { judgeId: suspended }), { code: "judge_not_found" });
  await assignJudgeToRound(org, competition, round, producer, { judgeId: j1, role: "panelist" });
  panel = await assignJudgeToRound(org, competition, round, producer, { judgeId: j2, role: "head" });
  assert.deepEqual(panel.assigned.map(a => [a.judgeId, a.role]), [[j2, "head"], [j1, "panelist"]]);
  panel = await removeJudgeFromRound(org, competition, round, producer, j1);
  assert.deepEqual(panel.assigned.map(a => a.judgeId), [j2]);
  await assert.rejects(removeJudgeFromRound(org, competition, round, producer, j1), { code: "panel_assignment_not_found" });
  const audit = await getSqlClient()<{ action: string }[]>`SELECT action FROM audit_events WHERE chain_key = ${org} AND subject_id = ${round} ORDER BY sequence`;
  assert.deepEqual(audit.map(a => a.action), ["round.judge_assigned", "round.judge_assigned", "round.judge_assigned", "round.judge_removed"]);
});

test("tenant isolation: rounds, judges and entries of another tenant are unreachable", async () => {
  const one = await setup();
  const two = await setup();
  await assert.rejects(setRoundLineup(two.org, one.competition, one.round, two.producer, { entryIds: [], expectedRevision: 0 }), { code: "round_not_found" });
  await assert.rejects(setRoundLineup(two.org, two.competition, two.round, two.producer, { entryIds: [one.entries[0]], expectedRevision: 0 }), { code: "entry_not_eligible" });
  const foreignJudge = await createCompetitionJudge(one.org, one.competition, { actorAccountId: one.producer });
  await assert.rejects(assignJudgeToRound(two.org, two.competition, two.round, two.producer, { judgeId: foreignJudge }), { code: "judge_not_found" });
  await assert.rejects(getRoundPanel(two.org, one.competition, one.round), { code: "round_not_found" });
  await assert.rejects(getSelectionSummary(two.org, one.competition), { code: "competition_not_found" });
});
