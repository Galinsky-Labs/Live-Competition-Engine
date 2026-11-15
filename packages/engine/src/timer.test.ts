import test from "node:test";
import assert from "node:assert/strict";
import { applyTimerCommand, initialTimer, parseTimerCommand, replayTimer, viewTimer, type TimerEvent } from "./timer.ts";

const limits = { maxExtensionMs: 60_000, graceMs: 10_000 };
const log: TimerEvent[] = [
  { seq: 1, at: 1_000, command: { type: "start", durationMs: 120_000 } },
  { seq: 2, at: 31_000, command: { type: "pause" } },
  { seq: 3, at: 91_000, command: { type: "resume" } },
  { seq: 4, at: 100_000, command: { type: "extend", ms: 30_000 } }
];

test("replay is deterministic: pauses stop the clock, extensions add time", () => {
  const state = replayTimer(log, limits);
  const view = viewTimer(state, 101_000, limits);
  assert.equal(view.elapsedMs, 40_000);
  assert.equal(view.remainingMs, 110_000);
  assert.deepEqual(replayTimer([...log].reverse(), limits), state, "log order on input does not matter");
});

test("overtime and grace are derived from server time", () => {
  const state = replayTimer(log, limits);
  const atEnd = 91_000 + (150_000 - 30_000);
  assert.equal(viewTimer(state, atEnd, limits).remainingMs, 0);
  assert.equal(viewTimer(state, atEnd + 5_000, limits).inGrace, true);
  const late = viewTimer(state, atEnd + 15_000, limits);
  assert.deepEqual([late.overtimeMs, late.inGrace], [15_000, false]);
});

test("invalid and conflicting commands are refused", () => {
  const state = replayTimer(log, limits);
  assert.throws(() => applyTimerCommand(state, { seq: 4, at: 1, command: { type: "pause" } }, limits), /timer_sequence_conflict/);
  assert.throws(() => applyTimerCommand(state, { seq: 5, at: 1, command: { type: "resume" } }, limits), /timer_not_paused/);
  assert.throws(() => applyTimerCommand(state, { seq: 5, at: 1, command: { type: "extend", ms: 40_000 } }, limits), /extension_limit_reached/);
  assert.throws(() => applyTimerCommand(initialTimer(), { seq: 1, at: 1, command: { type: "start", durationMs: 10 } }, { ...limits, maxDurationMs: 5 }), /exceeds_stage/);
  assert.throws(() => parseTimerCommand({ type: "start", durationMs: -1 }), /invalid_timer_duration/);
  assert.throws(() => parseTimerCommand({ type: "explode" }), /invalid_timer_command/);
  const stopped = applyTimerCommand(state, { seq: 5, at: 110_000, command: { type: "stop" } }, limits);
  assert.equal(viewTimer(stopped, 999_999, limits).elapsedMs, 49_000, "a stopped clock no longer advances");
});
