import { describe, expect, it } from "vitest";
import {
  assertPerformanceTransition,
  assertRoundTransition,
  assertShowTransition,
  canTransitionPerformance,
  canTransitionRound,
  normalizeReason,
  nowAndNext,
  planReorder,
  type LineupRound,
  type PerformanceStatus,
  type RoundStatus
} from "./control-room.ts";

const lineup = (overrides: Partial<Record<string, PerformanceStatus>> = {}, rounds: Partial<Record<string, RoundStatus>> = {}): LineupRound[] => [
  { id: "r1", ordinal: 1, status: rounds.r1 ?? "live", performances: [
    { id: "a", ordinal: 1, status: overrides.a ?? "completed" },
    { id: "b", ordinal: 2, status: overrides.b ?? "queued" },
    { id: "c", ordinal: 3, status: overrides.c ?? "queued" }
  ] },
  { id: "r2", ordinal: 2, status: rounds.r2 ?? "scheduled", performances: [
    { id: "d", ordinal: 1, status: overrides.d ?? "queued" }
  ] }
];

describe("state machines", () => {
  it("have explicit transitions", () => {
    const rounds: RoundStatus[] = ["scheduled", "live", "completed", "cancelled"];
    expect(rounds.flatMap(f => rounds.filter(t => canTransitionRound(f, t)).map(t => `${f}>${t}`)))
      .toEqual(["scheduled>live", "scheduled>cancelled", "live>completed", "live>cancelled"]);
    const perfs: PerformanceStatus[] = ["queued", "live", "completed", "skipped"];
    expect(perfs.flatMap(f => perfs.filter(t => canTransitionPerformance(f, t)).map(t => `${f}>${t}`)))
      .toEqual(["queued>live", "queued>skipped", "live>completed", "live>skipped"]);
    expect(() => assertShowTransition("standby", "running")).not.toThrow();
    expect(() => assertShowTransition("running", "paused")).not.toThrow();
    expect(() => assertShowTransition("ended", "running")).toThrow(/invalid_state_show_ended_to_running/);
    expect(() => assertShowTransition("standby", "paused")).toThrow(/invalid_state_show_standby_to_paused/);
  });

  it("guards performances going live", () => {
    expect(() => assertPerformanceTransition(lineup(), "b", "live", "running")).not.toThrow();
    expect(() => assertPerformanceTransition(lineup(), "b", "live", "paused")).toThrow(/invalid_state_show_paused/);
    expect(() => assertPerformanceTransition(lineup({ c: "live" }), "b", "live", "running")).toThrow(/invalid_state_performance_already_live/);
    expect(() => assertPerformanceTransition(lineup(), "d", "live", "running")).toThrow(/invalid_state_round_not_live/);
    expect(() => assertPerformanceTransition(lineup(), "a", "live", "running")).toThrow(/invalid_state_performance_completed_to_live/);
    expect(() => assertPerformanceTransition(lineup(), "zz", "live", "running")).toThrow(/performance_not_found/);
    // Skipping and completing are allowed while paused (safety stop does not trap the lineup).
    expect(() => assertPerformanceTransition(lineup({ b: "live" }), "b", "completed", "paused")).not.toThrow();
  });

  it("guards round transitions", () => {
    expect(() => assertRoundTransition(lineup(), "r1", "completed", "running")).toThrow(/invalid_state_round_has_pending_performances/);
    expect(() => assertRoundTransition(lineup({ b: "skipped", c: "completed" }), "r1", "completed", "running")).not.toThrow();
    expect(() => assertRoundTransition(lineup(), "r2", "live", "running")).toThrow(/invalid_state_another_round_live/);
    expect(() => assertRoundTransition(lineup({}, { r1: "completed" }), "r2", "live", "ended")).toThrow(/invalid_state_show_ended/);
    expect(() => assertRoundTransition(lineup({ b: "live" }), "r1", "cancelled", "running")).toThrow(/invalid_state_round_has_live_performance/);
    expect(() => assertRoundTransition(lineup(), "nope", "live", "running")).toThrow(/round_not_found/);
  });

  it("computes now and next", () => {
    expect(nowAndNext(lineup())).toEqual({ now: null, next: "b" });
    expect(nowAndNext(lineup({ b: "live" }))).toEqual({ now: "b", next: "c" });
    expect(nowAndNext(lineup({ b: "completed", c: "skipped" }))).toEqual({ now: null, next: "d" });
    expect(nowAndNext(lineup({}, { r2: "cancelled", r1: "completed" }))).toEqual({ now: null, next: null });
  });

  it("plans reorders that never move performances that left the queue", () => {
    const current = lineup()[0]!.performances;
    expect(planReorder(current, ["a", "c", "b"])).toEqual([{ id: "a", ordinal: 1 }, { id: "c", ordinal: 2 }, { id: "b", ordinal: 3 }]);
    expect(() => planReorder(current, ["b", "a", "c"])).toThrow(/invalid_state_lineup_fixed_performance_moved/);
    expect(() => planReorder(current, ["a", "b"])).toThrow(/invalid_lineup_order/);
    expect(() => planReorder(current, ["a", "b", "b"])).toThrow(/invalid_lineup_order/);
    expect(() => planReorder(current, ["a", "b", "x"])).toThrow(/invalid_lineup_order/);
  });

  it("bounds reasons", () => {
    expect(normalizeReason("  medical  ")).toBe("medical");
    expect(() => normalizeReason("")).toThrow(/invalid_reason/);
    expect(() => normalizeReason("x".repeat(201))).toThrow(/invalid_reason/);
    expect(() => normalizeReason("a\nb")).toThrow(/invalid_reason/);
    expect(() => normalizeReason(1)).toThrow(/invalid_reason/);
  });
});
