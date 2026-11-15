import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createLiveShow } from "./live-fixtures.ts";
import { createAccount, createEntry, grantRole } from "./test-fixtures.ts";
import {
  addPerformance,
  changeShowState,
  createRound,
  getControlRoom,
  reorderRound,
  safetyStop,
  setRoundPublication,
  transitionPerformance,
  transitionRound,
  type JudgeStatusSource
} from "./control-room.ts";
import { createTimer, getTimer, getTimerLog, issueTimerCommand } from "./timers.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

const key = () => `idem-${randomUUID()}`;

test("runs a show through the lineup with enforced transitions and now/next", async () => {
  const s = await createLiveShow();
  const o = s.organizationId, c = s.competitionId, p = s.producer;
  let room = await getControlRoom(o, c);
  assert.equal(room.show.state, "standby");
  assert.equal(room.next?.id, s.performanceA);
  assert.equal(room.judgeStatus, null);

  await assert.rejects(transitionPerformance(o, c, p, s.performanceA, "live"), /invalid_state_show_standby/);
  await changeShowState(o, c, p, "start");
  await assert.rejects(transitionPerformance(o, c, p, s.performanceA, "live"), /invalid_state_round_not_live/);
  await transitionRound(o, c, p, s.roundId, "live");
  await transitionPerformance(o, c, p, s.performanceA, "live");
  await assert.rejects(transitionPerformance(o, c, p, s.performanceB, "live"), /invalid_state_performance_already_live/);
  room = await getControlRoom(o, c);
  assert.equal(room.now?.id, s.performanceA);
  assert.equal(room.next?.id, s.performanceB);
  assert.equal(room.judgeStatus?.status, "unknown");
  await assert.rejects(transitionRound(o, c, p, s.roundId, "completed"), /invalid_state_round_has_pending_performances/);
  await transitionPerformance(o, c, p, s.performanceA, "completed");
  await transitionPerformance(o, c, p, s.performanceB, "skipped");
  await assert.rejects(transitionPerformance(o, c, p, s.performanceB, "live"), /invalid_state_performance_skipped_to_live/);
  await transitionRound(o, c, p, s.roundId, "completed");
  room = await getControlRoom(o, c);
  assert.equal(room.now, null);
  assert.equal(room.next, null);
  await changeShowState(o, c, p, "end");
  await assert.rejects(changeShowState(o, c, p, "start"), /invalid_state_show_ended_start/);
  const actions = await getSqlClient()<{ action: string }[]>`SELECT action FROM audit_events WHERE organization_id = ${o}
    AND action LIKE ANY (ARRAY['show.%', 'round.%', 'performance.%']) ORDER BY sequence`;
  assert.deepEqual(actions.map(a => a.action), [
    "show.start", "round.live", "performance.live", "performance.completed", "performance.skipped", "round.completed", "show.end"
  ]);
  assert.equal((await verifyAuditChain(o)).valid, true);
});

test("builds and reorders the lineup without moving performances that left the queue", async () => {
  const s = await createLiveShow();
  const o = s.organizationId, c = s.competitionId, p = s.producer;
  const extra = await createEntry(o, c, "Entrant C");
  const { performanceId: performanceC } = await addPerformance(o, c, p, { roundId: s.roundId, entryId: extra.entryId });
  const { roundId: round2 } = await createRound(o, c, p, { label: "Final" });
  assert.ok(round2);
  await reorderRound(o, c, p, s.roundId, [performanceC, s.performanceA, s.performanceB]);
  let room = await getControlRoom(o, c);
  assert.deepEqual(room.rounds[0]!.performances.map(x => x.displayName), ["Entrant C", "Entrant A", "Entrant B"]);
  assert.equal(room.next?.id, performanceC);
  await changeShowState(o, c, p, "start");
  await transitionRound(o, c, p, s.roundId, "live");
  await transitionPerformance(o, c, p, performanceC, "live");
  await assert.rejects(reorderRound(o, c, p, s.roundId, [s.performanceA, performanceC, s.performanceB]), /invalid_state_lineup_fixed_performance_moved/);
  await reorderRound(o, c, p, s.roundId, [performanceC, s.performanceB, s.performanceA]);
  room = await getControlRoom(o, c);
  assert.equal(room.next?.id, s.performanceB);
  await assert.rejects(reorderRound(o, c, p, s.roundId, [performanceC]), /invalid_lineup_order/);
  await assert.rejects(addPerformance(o, c, p, { roundId: s.roundId, entryId: randomUUID() }), /entry_not_found/);
  await assert.rejects(createRound(o, c, p, { label: " " }), /invalid_round_label/);
  await assert.rejects(transitionRound(o, c, p, round2, "live"), /invalid_state_another_round_live/);
  const stale = room.show.revision - 1;
  await assert.rejects(transitionPerformance(o, c, p, performanceC, "completed", stale), /show_revision_conflict/);
});

test("safety stop pauses the show and every running timer atomically; another producer resumes", async () => {
  const s = await createLiveShow();
  const o = s.organizationId, c = s.competitionId;
  const stage = await createTimer(o, c, s.producer, { label: "Stage", durationMs: 300_000 });
  const perf = await createTimer(o, c, s.producer, { performanceId: s.performanceA, label: "Set", durationMs: 120_000 });
  const idle = await createTimer(o, c, s.producer, { label: "Spare", durationMs: 60_000 });
  await changeShowState(o, c, s.producer, "start");
  await issueTimerCommand(o, stage.timerId, s.producer, { type: "start", idempotencyKey: key() });
  await issueTimerCommand(o, perf.timerId, s.producer, { type: "start", idempotencyKey: key() });
  await assert.rejects(safetyStop(o, c, s.producer, ""), /invalid_reason/);
  const stopped = await safetyStop(o, c, s.producer, "Medical incident in row B");
  assert.deepEqual(stopped.pausedTimerIds.sort(), [stage.timerId, perf.timerId].sort());
  for (const id of [stage.timerId, perf.timerId]) {
    const view = await getTimer(o, id);
    assert.equal(view.status, "paused");
    assert.equal(view.pauseReason, "safety_stop: Medical incident in row B");
  }
  assert.equal((await getTimer(o, idle.timerId)).status, "idle");
  const room = await getControlRoom(o, c);
  assert.deepEqual([room.show.state, room.show.pauseReason], ["paused", "Medical incident in row B"]);
  await assert.rejects(safetyStop(o, c, s.producer, "again"), /invalid_state_show_paused_safety_stop/);
  // The original producer disconnects; a backup producer resumes the show.
  const backup = await createAccount(o);
  await grantRole(backup, "event_producer", { organizationId: o, competitionId: c });
  await changeShowState(o, c, backup, "resume");
  assert.equal((await getControlRoom(o, c)).show.state, "running");
  assert.equal((await getTimer(o, stage.timerId)).status, "paused", "timers resume explicitly, never implicitly");
  const log = await getTimerLog(o, stage.timerId);
  assert.deepEqual(log.map(entry => entry.type), ["start", "pause"]);
});

test("safety stop and timer commands race without deadlock", async () => {
  const s = await createLiveShow();
  const o = s.organizationId, c = s.competitionId;
  const timers = await Promise.all([1, 2, 3].map(i => createTimer(o, c, s.producer, { label: `T${i}`, durationMs: 60_000, maxExtensionMs: 600_000 })));
  await changeShowState(o, c, s.producer, "start");
  for (const timer of timers) await issueTimerCommand(o, timer.timerId, s.producer, { type: "start", idempotencyKey: key() });
  const results = await Promise.allSettled([
    safetyStop(o, c, s.producer, "race"),
    ...timers.flatMap(timer => [1, 2].map(() =>
      issueTimerCommand(o, timer.timerId, s.producer, { type: "extend", amountMs: 1_000, idempotencyKey: key() })))
  ]);
  assert.equal(results[0]!.status, "fulfilled");
  assert.ok(results.every(r => r.status === "fulfilled"), "extends are legal while paused too");
  for (const timer of timers) assert.equal((await getTimer(o, timer.timerId)).status, "paused");
});

test("publishes round results with audit and revision guard", async () => {
  const s = await createLiveShow();
  const o = s.organizationId, c = s.competitionId;
  const first = await setRoundPublication(o, c, s.producer, s.roundId, { published: true, expectedRevision: 0 });
  assert.deepEqual(first, { roundId: s.roundId, resultsPublished: true, revision: 1 });
  await assert.rejects(setRoundPublication(o, c, s.producer, s.roundId, { published: false, expectedRevision: 0 }), /publication_revision_conflict/);
  const second = await setRoundPublication(o, c, s.producer, s.roundId, { published: false, expectedRevision: 1 });
  assert.equal(second.revision, 2);
  const audits = await getSqlClient()<{ action: string }[]>`SELECT action FROM audit_events WHERE organization_id = ${o} AND subject_id = ${s.roundId} ORDER BY sequence`;
  assert.deepEqual(audits.map(a => a.action), ["results.published", "results.unpublished"]);
});

test("judge status uses a pluggable source", async () => {
  const s = await createLiveShow();
  const source: JudgeStatusSource = {
    async forPerformance(_o, _c, performanceId) {
      return { performanceId, source: "test", status: "known", judges: [{ judgeId: "j", displayName: "J", submitted: true }] };
    }
  };
  await changeShowState(s.organizationId, s.competitionId, s.producer, "start");
  await transitionRound(s.organizationId, s.competitionId, s.producer, s.roundId, "live");
  await transitionPerformance(s.organizationId, s.competitionId, s.producer, s.performanceA, "live");
  const room = await getControlRoom(s.organizationId, s.competitionId, source);
  assert.deepEqual(room.judgeStatus, { performanceId: s.performanceA, source: "test", status: "known", judges: [{ judgeId: "j", displayName: "J", submitted: true }] });
});

test("rejects cross-tenant control room operations", async () => {
  const a = await createLiveShow();
  const b = await createLiveShow();
  await assert.rejects(getControlRoom(b.organizationId, a.competitionId), /competition_not_found/);
  await assert.rejects(changeShowState(b.organizationId, a.competitionId, b.producer, "start"), /competition_not_found/);
  await changeShowState(b.organizationId, b.competitionId, b.producer, "start");
  await assert.rejects(transitionRound(b.organizationId, b.competitionId, b.producer, a.roundId, "live"), /round_not_found/);
  await assert.rejects(transitionPerformance(b.organizationId, b.competitionId, b.producer, a.performanceA, "live"), /performance_not_found/);
  await assert.rejects(setRoundPublication(b.organizationId, b.competitionId, b.producer, a.roundId, { published: true }), /round_not_found/);
  await assert.rejects(addPerformance(b.organizationId, b.competitionId, b.producer, { roundId: b.roundId, entryId: a.entryA.entryId }), /entry_not_found/);
});
