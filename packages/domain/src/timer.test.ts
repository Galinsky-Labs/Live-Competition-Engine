import { describe, expect, it } from "vitest";
import {
  TIMER_LIMITS,
  applyTimerCommand,
  initialTimerState,
  replayTimer,
  snapshotTimer,
  timerCommandTypes,
  type TimerCommand,
  type TimerStatus
} from "./timer.ts";

const config = { durationMs: 60_000, maxExtensionMs: 30_000 };
const t0 = 1_700_000_000_000;

describe("timer reducer", () => {
  it("counts down only while running and derives overtime", () => {
    const log: TimerCommand[] = [
      { type: "start", at: t0 },
      { type: "pause", at: t0 + 10_000, reason: "technical" },
      { type: "resume", at: t0 + 25_000 },
      { type: "extend", at: t0 + 30_000, amountMs: 5_000 }
    ];
    const state = replayTimer(config, log);
    expect(state.status).toBe("running");
    expect(state.sequence).toBe(4);
    // 10s before the pause + 15s since resume at t0+40s
    expect(snapshotTimer(state, t0 + 40_000)).toMatchObject({ phase: "running", elapsedMs: 25_000, remainingMs: 40_000, overtimeMs: 0 });
    // total budget 65s; elapsed 10s + (t0+95s - t0+25s) = 80s -> 15s overtime
    expect(snapshotTimer(state, t0 + 95_000)).toMatchObject({ phase: "overtime", remainingMs: -15_000, overtimeMs: 15_000 });
    const paused = applyTimerCommand(state, { type: "pause", at: t0 + 95_000 });
    expect(snapshotTimer(paused, t0 + 500_000)).toMatchObject({ phase: "paused", remainingMs: -15_000, overtimeMs: 15_000 });
    expect(snapshotTimer(replayTimer(config, log.slice(0, 2)), t0 + 99_999)).toMatchObject({ phase: "paused", remainingMs: 50_000, pauseReason: "technical" });
  });

  it("is deterministic: the same log always yields the same state", () => {
    const log: TimerCommand[] = [
      { type: "extend", at: t0, amountMs: 1_000 },
      { type: "start", at: t0 + 1 },
      { type: "pause", at: t0 + 2 },
      { type: "reset", at: t0 + 3, durationMs: 90_000 },
      { type: "start", at: t0 + 4 }
    ];
    expect(replayTimer(config, log)).toEqual(replayTimer(config, [...log]));
    expect(replayTimer(config, log)).toMatchObject({ status: "running", durationMs: 90_000, extendedMs: 0, sequence: 5 });
  });

  it("allows exactly the documented transitions", () => {
    const states: Record<TimerStatus, ReturnType<typeof initialTimerState>> = {
      idle: initialTimerState(config),
      running: replayTimer(config, [{ type: "start", at: t0 }]),
      paused: replayTimer(config, [{ type: "start", at: t0 }, { type: "pause", at: t0 + 1 }])
    };
    const outcome: string[] = [];
    for (const [status, state] of Object.entries(states)) {
      for (const type of timerCommandTypes) {
        try {
          applyTimerCommand(state, { type, at: t0 + 10, ...(type === "extend" ? { amountMs: 1_000 } : {}) });
          outcome.push(`${status}:${type}`);
        } catch (error) {
          expect((error as { code: string }).code).toBe(`invalid_state_timer_${status}_${type}`);
        }
      }
    }
    expect(outcome.sort()).toEqual([
      "idle:extend", "idle:reset", "idle:start",
      "paused:extend", "paused:reset", "paused:resume",
      "running:extend", "running:pause", "running:reset"
    ]);
  });

  it("bounds extensions, durations, reasons and log length", () => {
    const idle = initialTimerState(config);
    expect(() => applyTimerCommand(idle, { type: "extend", at: t0, amountMs: 999 })).toThrow(/invalid_timer_extension/);
    expect(() => applyTimerCommand(idle, { type: "extend", at: t0, amountMs: TIMER_LIMITS.maxExtendStepMs + 1 })).toThrow(/invalid_timer_extension/);
    const extended = applyTimerCommand(idle, { type: "extend", at: t0, amountMs: 30_000 });
    expect(() => applyTimerCommand(extended, { type: "extend", at: t0, amountMs: 1_000 })).toThrow(/timer_extension_limit_exceeded/);
    expect(() => applyTimerCommand(idle, { type: "reset", at: t0, durationMs: 10 })).toThrow(/invalid_timer_duration/);
    expect(() => applyTimerCommand(idle, { type: "start", at: t0, amountMs: 5 })).toThrow(/invalid_timer_command/);
    expect(() => applyTimerCommand(idle, { type: "start", at: t0, reason: "x".repeat(201) })).toThrow(/invalid_timer_reason/);
    expect(() => applyTimerCommand(idle, { type: "explode" as "start", at: t0 })).toThrow(/invalid_timer_command/);
    expect(() => applyTimerCommand(idle, { type: "start", at: Number.NaN })).toThrow(/invalid_timer_command/);
    expect(() => initialTimerState({ durationMs: 0, maxExtensionMs: 0 })).toThrow(/invalid_timer_duration/);
    expect(() => initialTimerState({ durationMs: 1_000, maxExtensionMs: -1 })).toThrow(/invalid_timer_max_extension/);
    expect(() => applyTimerCommand({ ...idle, sequence: TIMER_LIMITS.maxCommands }, { type: "start", at: t0 })).toThrow(/timer_command_limit/);
  });

  it("clamps out-of-order server timestamps to stay monotonic", () => {
    const state = replayTimer(config, [{ type: "start", at: t0 + 5_000 }, { type: "pause", at: t0 }]);
    expect(state.elapsedBeforeMs).toBe(0);
    expect(state.lastAt).toBe(t0 + 5_000);
    expect(snapshotTimer(state, t0).serverNow).toBe(t0 + 5_000);
  });

  it("keeps running with no producer connected: state depends only on log and clock", () => {
    const state = replayTimer(config, [{ type: "start", at: t0 }]);
    expect(snapshotTimer(state, t0 + 59_000).remainingMs).toBe(1_000);
    expect(snapshotTimer(state, t0 + 3_600_000)).toMatchObject({ phase: "overtime", overtimeMs: 3_540_000 });
    expect(snapshotTimer(initialTimerState(config), t0)).toMatchObject({ phase: "idle", remainingMs: 60_000, serverNow: t0 });
  });
});
