import { describe, expect, it } from "vitest";
import { generateSingleElimination, planMatchAction, seedOrder } from "./brackets.ts";

const sides = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `side-${i + 1}`, seed: i + 1 }));

describe("seeded single elimination", () => {
  it("uses the standard seed order", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(() => seedOrder(6)).toThrow("invalid_bracket_size");
  });

  it("pairs seed 1 vs N in a full bracket and links matches toward the final", () => {
    const bracket = generateSingleElimination(sides(8));
    expect(bracket.size).toBe(8);
    expect(bracket.rounds).toBe(3);
    expect(bracket.matches).toHaveLength(7);
    const first = bracket.matches.filter(m => m.round === 1).map(m => m.sides.map(s => s.seed));
    expect(first).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
    expect(bracket.matches.find(m => m.round === 1 && m.position === 3)?.next).toEqual({ round: 2, position: 1, slot: 1 });
    expect(bracket.matches.find(m => m.round === 3)?.next).toBeNull();
    expect(bracket.matches.every(m => !m.bye)).toBe(true);
  });

  it("gives byes to the top seeds and advances them immediately", () => {
    const bracket = generateSingleElimination(sides(6));
    expect(bracket.size).toBe(8);
    const byes = bracket.matches.filter(m => m.bye);
    expect(byes.map(m => m.sides[0]!.seed).sort()).toEqual([1, 2]);
    for (const bye of byes) {
      expect(bye.status).toBe("decided");
      expect(bye.winnerSlot).toBe(bye.sides[0]!.slot);
    }
    const semis = bracket.matches.filter(m => m.round === 2).map(m => m.sides.map(s => s.seed));
    expect(semis).toEqual([[1], [2]]);
  });

  it("handles the smallest and odd sizes deterministically", () => {
    expect(generateSingleElimination(sides(2)).matches).toHaveLength(1);
    const three = generateSingleElimination(sides(3));
    expect(three.matches.filter(m => m.round === 1).map(m => m.sides.map(s => s.seed))).toEqual([[1], [2, 3]]);
    expect(three.matches.find(m => m.round === 2)?.sides).toEqual([{ slot: 0, key: "side-1", seed: 1 }]);
    expect(generateSingleElimination([...sides(5)].reverse())).toEqual(generateSingleElimination(sides(5)));
  });

  it("rejects invalid seeds", () => {
    expect(() => generateSingleElimination(sides(1))).toThrow("invalid_bracket_size");
    expect(() => generateSingleElimination([{ key: "a", seed: 1 }, { key: "b", seed: 3 }])).toThrow("invalid_bracket_seeds");
    expect(() => generateSingleElimination([{ key: "a", seed: 1 }, { key: "a", seed: 2 }])).toThrow("invalid_bracket_seeds");
    expect(() => generateSingleElimination([{ key: "a", seed: 1 }, { key: "b", seed: 1 }])).toThrow("invalid_bracket_seeds");
  });
});

describe("match lifecycle", () => {
  it("enforces scheduled → live → decided and void with reason", () => {
    expect(planMatchAction("scheduled", "start", { filledSlots: [0, 1], expectedSides: 2 })).toBe("live");
    expect(() => planMatchAction("scheduled", "start", { filledSlots: [0], expectedSides: 2 })).toThrow("invalid_state_match_sides_incomplete");
    expect(() => planMatchAction("scheduled", "decide", { filledSlots: [0, 1], expectedSides: 2, winnerSlot: 0 })).toThrow("invalid_state_match_transition");
    expect(planMatchAction("live", "decide", { filledSlots: [0, 1], expectedSides: 2, winnerSlot: 1 })).toBe("decided");
    expect(() => planMatchAction("live", "decide", { filledSlots: [0, 1], expectedSides: 2, winnerSlot: 2 })).toThrow("invalid_match_winner");
    expect(() => planMatchAction("live", "void", { filledSlots: [0, 1], expectedSides: 2 })).toThrow("void_reason_required");
    expect(planMatchAction("live", "void", { filledSlots: [0, 1], expectedSides: 2, reason: "Technical failure" })).toBe("void");
    expect(() => planMatchAction("decided", "void", { filledSlots: [0, 1], expectedSides: 2, reason: "x" })).toThrow("invalid_state_match_transition");
    expect(planMatchAction("scheduled", "start", { filledSlots: [0, 1, 2], expectedSides: 3 })).toBe("live");
  });
});
