import { describe, expect, it } from "vitest";
import {
  assertPermutation,
  computeAdvancement,
  parseAdvancementContract,
  parseStageDefinition,
  type Standing
} from "./stages.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// ranks: 1, 2, 3, 3, 3, 6 (ties at rank 3), unranked last
const standings: Standing[] = [
  { entryId: id(6), rank: 6, score: 50, seed: 6 },
  { entryId: id(3), rank: 3, score: 80, seed: 5 },
  { entryId: id(1), rank: 1, score: 95, seed: 1 },
  { entryId: id(4), rank: 3, score: 80, seed: 2 },
  { entryId: id(2), rank: 2, score: 90, seed: 4 },
  { entryId: id(5), rank: 3, score: 80, seed: null },
  { entryId: id(7), rank: null, score: null }
];

describe("advancement contracts", () => {
  it("top-N without a tie at the cut", () => {
    const outcome = computeAdvancement({ type: "top_n", count: 2, ties: "include" }, standings);
    expect(outcome.advancing).toEqual([id(1), id(2)]);
    expect(outcome.tiedAtCut).toEqual([]);
    expect(outcome.eliminated).toHaveLength(5);
  });

  it("top-N tie policies: include, exclude, seed", () => {
    const include = computeAdvancement({ type: "top_n", count: 4, ties: "include" }, standings);
    expect(include.advancing).toEqual([id(1), id(2), id(4), id(3), id(5)]);
    expect(include.tiedAtCut).toEqual([id(4), id(3), id(5)]);
    const exclude = computeAdvancement({ type: "top_n", count: 4, ties: "exclude" }, standings);
    expect(exclude.advancing).toEqual([id(1), id(2)]);
    const seed = computeAdvancement({ type: "top_n", count: 4, ties: "seed" }, standings);
    // Tied group ordered by seed (2, 5, null) -> entries 4 and 3 advance.
    expect(seed.advancing).toEqual([id(1), id(2), id(4), id(3)]);
    expect(seed.tieBroken).toBe(true);
  });

  it("is deterministic regardless of input order", () => {
    const contract = { type: "top_n" as const, count: 3, ties: "seed" as const };
    const reference = computeAdvancement(contract, standings);
    for (let i = 0; i < 20; i += 1) {
      const shuffled = [...standings].sort(() => (Math.sin(i * 97 + standings.length) > 0 ? 1 : -1));
      expect(computeAdvancement(contract, shuffled)).toEqual(reference);
    }
  });

  it("score threshold honours inclusivity and skips unscored entries", () => {
    expect(computeAdvancement({ type: "score_threshold", minScore: 80, inclusive: true }, standings).advancing)
      .toEqual([id(1), id(2), id(4), id(3), id(5)]);
    expect(computeAdvancement({ type: "score_threshold", minScore: 80, inclusive: false }, standings).advancing)
      .toEqual([id(1), id(2)]);
  });

  it("manual and bracket contracts require a valid selection", () => {
    expect(() => computeAdvancement({ type: "manual" }, standings)).toThrow("advancement_selection_required");
    expect(() => computeAdvancement({ type: "manual", maxSelections: 1 }, standings, [id(1), id(2)])).toThrow("invalid_advancement_selection");
    expect(() => computeAdvancement({ type: "manual" }, standings, [id(99)])).toThrow("invalid_advancement_selection");
    expect(() => computeAdvancement({ type: "manual" }, standings, [id(1), id(1)])).toThrow("invalid_advancement_selection");
    expect(computeAdvancement({ type: "manual" }, standings, [id(6), id(1)]).advancing).toEqual([id(1), id(6)]);
    expect(computeAdvancement({ type: "bracket" }, standings, [id(2)]).advancing).toEqual([id(2)]);
  });

  it("rejects malformed standings and contracts", () => {
    expect(() => computeAdvancement({ type: "top_n", count: 1, ties: "include" }, [standings[0]!, standings[0]!])).toThrow("invalid_standings");
    expect(() => computeAdvancement({ type: "top_n", count: 1, ties: "include" }, [{ entryId: id(1), rank: 0, score: null }])).toThrow("invalid_standings");
    for (const bad of [{ type: "top_n", count: 0, ties: "include" }, { type: "lottery" }, { type: "manual", extra: 1 }, null]) {
      expect(() => parseAdvancementContract(bad)).toThrow("invalid_advancement_contract");
    }
  });
});

describe("stage definitions", () => {
  it("validates kind, custom label and timing", () => {
    const base = { label: "Heats", kind: "heat", timed: true, durationSeconds: 600 };
    expect(parseStageDefinition(base).advancement).toBeNull();
    expect(() => parseStageDefinition({ ...base, timed: false })).toThrow("invalid_stage_timing");
    expect(() => parseStageDefinition({ ...base, kind: "custom" })).toThrow("invalid_stage_custom_label");
    expect(parseStageDefinition({ ...base, kind: "custom", customLabel: "Showcase" }).customLabel).toBe("Showcase");
    expect(() => parseStageDefinition({ ...base, kind: "battle-royale" })).toThrow("invalid_stage_kind");
    expect(() => parseStageDefinition({ ...base, ordinal: 3 })).toThrow("invalid_stage_field");
    const current = parseStageDefinition({ ...base, advancement: { type: "top_n", count: 8, ties: "include" } });
    const patched = parseStageDefinition({ timed: false, durationSeconds: null }, current);
    expect(patched.timed).toBe(false);
    expect(patched.advancement?.type).toBe("top_n");
  });

  it("accepts only permutations for reordering", () => {
    expect(assertPermutation([id(1), id(2)], [id(2), id(1)])).toEqual([id(2), id(1)]);
    for (const bad of [[id(1)], [id(1), id(1)], [id(1), id(3)], "x"]) {
      expect(() => assertPermutation([id(1), id(2)], bad)).toThrow("invalid_stage_order");
    }
  });
});
