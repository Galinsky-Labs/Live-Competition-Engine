import { describe, expect, it } from "vitest";
import {
  rankScores,
  tallyApproval,
  tallyBallots,
  tallyBorda,
  tallyInstantRunoff,
  tallyPlurality,
  tallyPoints,
  type WeightedBallot
} from "./voting-tally";

const options = ["A", "B", "C", "D"];
const single = (optionId: string, weight = 1): WeightedBallot => ({ weight, choice: { optionId } });
const ranked = (ranking: string[], weight = 1): WeightedBallot => ({ weight, choice: { ranking } });
const repeat = <T>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

describe("ranking and ties", () => {
  it("shares ranks for equal scores and orders ties by option order", () => {
    const { rows, winners } = rankScores(["A", "B", "C"], new Map([["A", 2], ["B", 5], ["C", 5]]), 12);
    expect(rows).toEqual([
      { optionId: "B", score: 5, rank: 1 },
      { optionId: "C", score: 5, rank: 1 },
      { optionId: "A", score: 2, rank: 3 }
    ]);
    expect(winners).toEqual(["B", "C"]);
  });

  it("reports no winners without counted weight", () => {
    const result = tallyPlurality(options, []);
    expect(result.winners).toEqual([]);
    expect(result.rows.every(row => row.rank === 1 && row.score === 0)).toBe(true);
    expect(result.ballotCount).toBe(0);
  });

  it("is independent of ballot order", () => {
    const ballots = [single("A"), single("B", 3), single("C"), single("B"), single("A", 2)];
    const forward = tallyPlurality(options, ballots);
    const backward = tallyPlurality(options, [...ballots].reverse());
    expect(forward).toEqual(backward);
  });

  it("rejects malformed inputs", () => {
    expect(() => tallyPlurality([], [])).toThrow("invalid_tally_options");
    expect(() => tallyPlurality(["A", "A"], [])).toThrow("invalid_tally_options");
    expect(() => tallyPlurality(options, [single("Z")])).toThrow("invalid_tally_ballot");
    expect(() => tallyPlurality(options, [single("A", 0)])).toThrow("invalid_tally_ballot");
    expect(() => tallyPlurality(options, [single("A", 1.5)])).toThrow("invalid_tally_ballot");
    expect(() => tallyPlurality(options, [ranked(["A"])])).toThrow("invalid_tally_ballot");
    expect(() => tallyApproval(options, [{ weight: 1, choice: { optionIds: ["A", "A"] } }])).toThrow("invalid_tally_ballot");
    expect(() => tallyPoints(options, [{ weight: 1, choice: { allocations: { A: -1 } } }])).toThrow("invalid_tally_ballot");
    expect(() => tallyBorda(options, [ranked(["A", "A"])])).toThrow("invalid_tally_ballot");
    expect(() => tallyInstantRunoff(options, [ranked(["Q"])])).toThrow("invalid_tally_ballot");
    expect(() => tallyBallots("nope" as never, options, [])).toThrow("invalid_tally_method");
  });
});

describe("plurality", () => {
  it("counts weighted single choices", () => {
    const result = tallyPlurality(options, [single("A"), single("B", 2), single("B"), single("C", 3)]);
    expect(result.rows.map(row => [row.optionId, row.score, row.rank])).toEqual([["B", 3, 1], ["C", 3, 1], ["A", 1, 3], ["D", 0, 4]]);
    expect(result.winners).toEqual(["B", "C"]);
    expect(result.totalWeight).toBe(7);
  });
});

describe("approval", () => {
  it("counts each approved option once per ballot, weighted", () => {
    const result = tallyApproval(options, [
      { weight: 1, choice: { optionIds: ["A", "B"] } },
      { weight: 2, choice: { optionIds: ["B"] } },
      { weight: 1, choice: { optionIds: ["C", "B", "D"] } }
    ]);
    expect(result.winners).toEqual(["B"]);
    expect(Object.fromEntries(result.rows.map(row => [row.optionId, row.score]))).toEqual({ A: 1, B: 4, C: 1, D: 1 });
  });
});

describe("points (N votes distributed)", () => {
  it("sums weighted allocations", () => {
    const result = tallyPoints(options, [
      { weight: 1, choice: { allocations: { A: 3, B: 2 } } },
      { weight: 2, choice: { allocations: { C: 2 } } }
    ]);
    expect(Object.fromEntries(result.rows.map(row => [row.optionId, row.score]))).toEqual({ A: 3, B: 2, C: 4, D: 0 });
    expect(result.winners).toEqual(["C"]);
  });
});

describe("Borda", () => {
  it("awards n-1-i points per position, unranked options score 0", () => {
    const result = tallyBorda(["A", "B", "C"], [ranked(["A", "B", "C"]), ranked(["B", "C"]), ranked(["C"], 2)]);
    // A: 2 ; B: 1 + 2 = 3 ; C: 0 + 1 + 2*2 = 5
    expect(Object.fromEntries(result.rows.map(row => [row.optionId, row.score]))).toEqual({ A: 2, B: 3, C: 5 });
    expect(result.winners).toEqual(["C"]);
  });

  it("reports a Borda tie", () => {
    const result = tallyBorda(["A", "B"], [ranked(["A", "B"]), ranked(["B", "A"])]);
    expect(result.winners).toEqual(["A", "B"]);
  });
});

describe("instant runoff", () => {
  it("elects a first-round majority without eliminations", () => {
    const result = tallyInstantRunoff(["A", "B", "C"], [...repeat(3, ranked(["A"])), ranked(["B"]), ranked(["C"])]);
    expect(result.winners).toEqual(["A"]);
    expect(result.rounds).toHaveLength(1);
  });

  it("transfers votes after eliminating the weakest option", () => {
    const ballots = [
      ...repeat(4, ranked(["A", "B"])),
      ...repeat(3, ranked(["B", "A"])),
      ...repeat(2, ranked(["C", "B"]))
    ];
    const result = tallyInstantRunoff(["A", "B", "C"], ballots);
    expect(result.rounds?.[0]).toMatchObject({ totals: { A: 4, B: 3, C: 2 }, eliminated: "C" });
    expect(result.rounds?.[1]).toMatchObject({ totals: { A: 4, B: 5 }, eliminated: null });
    expect(result.winners).toEqual(["B"]);
    expect(result.rows.map(row => [row.optionId, row.rank])).toEqual([["B", 1], ["A", 2], ["C", 3]]);
  });

  it("counts exhausted ballots and uses weights", () => {
    const ballots = [ranked(["A"], 3), ranked(["B"], 2), ranked(["C", "B"], 2), ranked(["C"])];
    // Round 1: A3 B2 C3 -> no majority of 8; lowest B eliminated.
    // Round 2: A3 C3, exhausted 2 -> all tied -> A and C tie.
    const result = tallyInstantRunoff(["A", "B", "C"], ballots);
    expect(result.rounds?.[0]?.eliminated).toBe("B");
    expect(result.rounds?.[1]).toMatchObject({ totals: { A: 3, C: 3 }, exhausted: 2 });
    expect(result.winners).toEqual(["A", "C"]);
  });

  it("breaks elimination ties backwards, then by later option order", () => {
    // Round 1: A4 B3 C3 D1 -> D eliminated, D's ballot goes to C.
    // Round 2: A4 B3 C4 -> B eliminated (lowest), transfers to A.
    const ballots = [...repeat(4, ranked(["A"])), ...repeat(3, ranked(["B", "A"])), ...repeat(3, ranked(["C"])), ranked(["D", "C"])];
    const result = tallyInstantRunoff(["A", "B", "C", "D"], ballots);
    expect(result.rounds?.map(round => round.eliminated)).toEqual(["D", "B", null]);
    expect(result.winners).toEqual(["A"]);

    // Equal at the bottom in every round: the later option is eliminated first.
    const tie = tallyInstantRunoff(["A", "B", "C"], [...repeat(2, ranked(["A"])), ranked(["B", "A"]), ranked(["C", "B"])]);
    expect(tie.rounds?.[0]?.eliminated).toBe("C");

    // Backward tie-break: B and C tie in round 2 but B was lower in round 1.
    const backward = tallyInstantRunoff(["A", "B", "C", "D"], [
      ...repeat(5, ranked(["A"])),
      ...repeat(2, ranked(["B"])),
      ...repeat(3, ranked(["C"])),
      ranked(["D", "B"])
    ]);
    // Round 1: A5 B2 C3 D1 -> D out -> B3. Round 2: A5 B3 C3 -> B (round-1 total 2 < 3) out.
    expect(backward.rounds?.map(round => round.eliminated).slice(0, 2)).toEqual(["D", "B"]);
  });

  it("returns no winner when every ballot is empty of continuing options", () => {
    const result = tallyInstantRunoff(["A", "B"], []);
    expect(result.winners).toEqual([]);
  });

  it("is deterministic for many permutations of the same ballots", () => {
    const ballots = [ranked(["A", "B", "C"]), ranked(["B", "C"]), ranked(["C", "A"]), ranked(["B"], 2), ranked(["A"], 2)];
    const reference = tallyInstantRunoff(["A", "B", "C"], ballots);
    for (let shift = 1; shift < ballots.length; shift++) {
      const rotated = [...ballots.slice(shift), ...ballots.slice(0, shift)];
      expect(tallyInstantRunoff(["A", "B", "C"], rotated)).toEqual(reference);
    }
  });
});

describe("dispatcher", () => {
  it("routes to every method", () => {
    expect(tallyBallots("plurality", options, [single("A")]).winners).toEqual(["A"]);
    expect(tallyBallots("approval", options, [{ weight: 1, choice: { optionIds: ["D"] } }]).winners).toEqual(["D"]);
    expect(tallyBallots("points", options, [{ weight: 1, choice: { allocations: { B: 1 } } }]).winners).toEqual(["B"]);
    expect(tallyBallots("borda", options, [ranked(["C"])]).winners).toEqual(["C"]);
    expect(tallyBallots("irv", options, [ranked(["D"])]).winners).toEqual(["D"]);
  });
});
