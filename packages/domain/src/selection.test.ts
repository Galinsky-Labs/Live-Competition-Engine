import { describe, expect, it } from "vitest";
import { parseLineup, parsePanelRole, planLineup, type CurrentSlot } from "./selection";

const e = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const p = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slot = (n: number, ordinal: number, status: CurrentSlot["status"] = "queued"): CurrentSlot =>
  ({ performanceId: p(n), entryId: e(n), ordinal, status });

describe("lineup planning", () => {
  it("creates an initial lineup", () => {
    expect(planLineup([], [e(1), e(2)])).toEqual({
      moves: [], deletes: [], inserts: [{ entryId: e(1), ordinal: 1 }, { entryId: e(2), ordinal: 2 }],
      order: [{ entryId: e(1), ordinal: 1 }, { entryId: e(2), ordinal: 2 }]
    });
  });

  it("reorders, removes and adds with minimal changes", () => {
    const plan = planLineup([slot(1, 1), slot(2, 2), slot(3, 3)], [e(3), e(2), e(4)]);
    expect(plan.moves).toEqual([{ performanceId: p(3), ordinal: 1 }]);
    expect(plan.deletes).toEqual([p(1)]);
    expect(plan.inserts).toEqual([{ entryId: e(4), ordinal: 3 }]);
  });

  it("is a no-op when nothing changes", () => {
    expect(planLineup([slot(1, 1), slot(2, 2)], [e(1), e(2)])).toMatchObject({ moves: [], inserts: [], deletes: [] });
  });

  it("refuses to move or remove started performances", () => {
    expect(() => planLineup([slot(1, 1, "completed"), slot(2, 2)], [e(2), e(1)]))
      .toThrowError(expect.objectContaining({ code: "invalid_state_performance_started" }));
    expect(() => planLineup([slot(1, 1, "live")], []))
      .toThrowError(expect.objectContaining({ code: "invalid_state_performance_started" }));
    expect(planLineup([slot(1, 1, "completed"), slot(2, 2)], [e(1), e(3)]).deletes).toEqual([p(2)]);
  });

  it("rejects duplicate current slots for one entry", () => {
    expect(() => planLineup([slot(1, 1), { ...slot(1, 2), performanceId: p(9) }], [e(1)]))
      .toThrowError(expect.objectContaining({ code: "invalid_state_duplicate_slot" }));
  });

  it("validates lineup input", () => {
    expect(parseLineup([e(1).toUpperCase()])).toEqual([e(1)]);
    for (const bad of [null, "x", [e(1), e(1)], ["nope"], Array.from({ length: 501 }, (_, i) => e(i))]) {
      expect(() => parseLineup(bad)).toThrowError(expect.objectContaining({ code: "invalid_lineup" }));
    }
  });

  it("validates panel roles", () => {
    expect(parsePanelRole(undefined)).toBe("panelist");
    expect(parsePanelRole("head")).toBe("head");
    expect(() => parsePanelRole("chair")).toThrowError(expect.objectContaining({ code: "invalid_panel_role" }));
  });
});
