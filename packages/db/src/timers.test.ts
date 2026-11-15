import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { replayTimer } from "@live-competition-engine/domain/timer";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createLiveShow } from "./live-fixtures.ts";
import { createAccount, grantRole } from "./test-fixtures.ts";
import { createTimer, getTimer, getTimerLog, issueTimerCommand, listTimers } from "./timers.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

const key = () => `idem-${randomUUID()}`;

/** Controllable server clock for deterministic assertions. */
function fakeClock(start = 1_800_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms: number) => { now += ms; };
  return clock;
}

test("derives timer state from the append-only log; another producer can take over", async () => {
  const s = await createLiveShow();
  const backup = await createAccount(s.organizationId);
  await grantRole(backup, "event_producer", { organizationId: s.organizationId, competitionId: s.competitionId });
  const clock = fakeClock();
  const timer = await createTimer(s.organizationId, s.competitionId, s.producer, { performanceId: s.performanceA, label: "Set", durationMs: 120_000, maxExtensionMs: 60_000 });
  assert.equal(timer.phase, "idle");

  await issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "start", idempotencyKey: key() }, clock);
  clock.advance(30_000);
  // Producer A disconnects. The timer keeps running server-side.
  clock.advance(100_000);
  const mid = await getTimer(s.organizationId, timer.timerId, clock);
  assert.equal(mid.phase, "overtime");
  assert.equal(mid.remainingMs, -10_000);
  // Producer B takes over and extends, then pauses.
  const extended = await issueTimerCommand(s.organizationId, timer.timerId, backup, { type: "extend", amountMs: 30_000, idempotencyKey: key() }, clock);
  assert.equal(extended.view.remainingMs, 20_000);
  assert.equal(extended.view.phase, "running");
  clock.advance(5_000);
  const paused = await issueTimerCommand(s.organizationId, timer.timerId, backup, { type: "pause", reason: "audio", idempotencyKey: key(), expectedSequence: 2 }, clock);
  assert.deepEqual([paused.view.phase, paused.view.remainingMs, paused.view.sequence, paused.view.pauseReason], ["paused", 15_000, 3, "audio"]);
  clock.advance(60_000);
  assert.equal((await getTimer(s.organizationId, timer.timerId, clock)).remainingMs, 15_000);

  await assert.rejects(issueTimerCommand(s.organizationId, timer.timerId, backup, { type: "start", idempotencyKey: key() }, clock), /invalid_state_timer_paused_start/);
  await assert.rejects(issueTimerCommand(s.organizationId, timer.timerId, backup, { type: "resume", idempotencyKey: key(), expectedSequence: 1 }, clock), /timer_sequence_conflict/);
  await assert.rejects(issueTimerCommand(s.organizationId, timer.timerId, backup, { type: "extend", amountMs: 40_000, idempotencyKey: key() }, clock), /timer_extension_limit_exceeded/);

  // The log alone reproduces the state.
  const log = await getTimerLog(s.organizationId, timer.timerId);
  assert.deepEqual(log.map(entry => entry.type), ["start", "extend", "pause"]);
  assert.deepEqual(log.map(entry => entry.actorAccountId), [s.producer, backup, backup]);
  const replayed = replayTimer({ durationMs: 120_000, maxExtensionMs: 60_000 }, log.map(entry => ({ ...entry })));
  assert.equal(replayed.elapsedBeforeMs, 135_000);
  await assert.rejects(getSqlClient()`UPDATE stage_timer_commands SET amount_ms = 600000 WHERE timer_id = ${timer.timerId}`, /append-only/);
  assert.equal((await verifyAuditChain(s.organizationId)).valid, true);
});

test("idempotent retries return the same result without appending", async () => {
  const s = await createLiveShow();
  const timer = await createTimer(s.organizationId, s.competitionId, s.producer, { label: "Stage", durationMs: 60_000 });
  const idem = key();
  const first = await issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "start", idempotencyKey: idem });
  const retry = await issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "start", idempotencyKey: idem });
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.view.sequence, 1);
  await assert.rejects(issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "pause", idempotencyKey: idem }), /idempotency_conflict/);
  await assert.rejects(issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "extend", amountMs: 1, idempotencyKey: key() }), /invalid_timer_extension/);
});

test("serializes concurrent commands: exactly one pause wins, extends get unique sequences", async () => {
  const s = await createLiveShow();
  const timer = await createTimer(s.organizationId, s.competitionId, s.producer, { label: "Race", durationMs: 60_000, maxExtensionMs: 600_000 });
  await issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "start", idempotencyKey: key() });
  const pauses = await Promise.allSettled(Array.from({ length: 8 }, () =>
    issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "pause", idempotencyKey: key() })));
  assert.equal(pauses.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(pauses.filter(result => result.status === "rejected").every(result => /invalid_state_timer_paused_pause/.test(String((result as PromiseRejectedResult).reason))));
  await Promise.all(Array.from({ length: 6 }, () =>
    issueTimerCommand(s.organizationId, timer.timerId, s.producer, { type: "extend", amountMs: 10_000, idempotencyKey: key() })));
  const log = await getTimerLog(s.organizationId, timer.timerId);
  assert.deepEqual(log.map(entry => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  const view = await getTimer(s.organizationId, timer.timerId);
  assert.equal(view.extendedMs, 60_000);
  assert.ok(log.every((entry, index) => index === 0 || entry.at >= log[index - 1]!.at), "timestamps are monotonic");
});

test("rejects cross-tenant timer access and invalid configuration", async () => {
  const a = await createLiveShow();
  const b = await createLiveShow();
  const timer = await createTimer(a.organizationId, a.competitionId, a.producer, { performanceId: a.performanceA, label: "A", durationMs: 60_000 });
  await assert.rejects(getTimer(b.organizationId, timer.timerId), /timer_not_found/);
  await assert.rejects(issueTimerCommand(b.organizationId, timer.timerId, b.producer, { type: "start", idempotencyKey: key() }), /timer_not_found/);
  await assert.rejects(createTimer(b.organizationId, b.competitionId, b.producer, { performanceId: a.performanceA, label: "x", durationMs: 60_000 }), /performance_not_found/);
  await assert.rejects(createTimer(b.organizationId, a.competitionId, b.producer, { label: "x", durationMs: 60_000 }), /competition_not_found/);
  assert.equal((await listTimers(b.organizationId, a.competitionId)).length, 0);
  await assert.rejects(createTimer(a.organizationId, a.competitionId, a.producer, { performanceId: a.performanceA, label: "dup", durationMs: 60_000 }), /timer_conflict_performance_has_timer/);
  await assert.rejects(createTimer(a.organizationId, a.competitionId, a.producer, { label: "", durationMs: 60_000 }), /invalid_timer_label/);
  await assert.rejects(createTimer(a.organizationId, a.competitionId, a.producer, { label: "x", durationMs: 10 }), /invalid_timer_duration/);
});
