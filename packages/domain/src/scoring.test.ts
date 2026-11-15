import { describe, expect, it } from "vitest";
import {
  aggregate, assertCorrection, assertCorrectionDecision, computeStandings, median, parseRubric, quantize, sameValues,
  sheetScore, validateScoreValues, zScores, type Rubric, type StandingSheet
} from "./scoring";

const code = (c: string) => expect.objectContaining({ code: c });
const rubric = (overrides: Record<string, unknown> = {}): Rubric => parseRubric({
  criteria: [
    { key: "craft", label: "Craft", min: 0, max: 10, step: 0.5, weight: 2 },
    { key: "impact", label: "Impact", min: 0, max: 10, step: 1, weight: 1 }
  ],
  aggregation: { method: "weighted_mean" },
  ...overrides
});
const sheet = (judgeId: string, entryId: string, craft: number, impact: number, extra: Partial<StandingSheet> = {}): StandingSheet =>
  ({ judgeId, entryId, performanceId: `p-${entryId}`, values: { craft, impact }, headJudge: false, ...extra });

describe("rubric validation", () => {
  it("applies defaults", () => {
    const r = parseRubric({ criteria: [{ key: "a", label: "A", min: 1, max: 5, step: 1 }] });
    expect(r).toEqual({ criteria: [{ key: "a", label: "A", min: 1, max: 5, step: 1, weight: 1 }], aggregation: { method: "weighted_mean", trim: 0 }, normalization: "none", tieBreakers: [] });
  });

  const base = { key: "a", label: "A", min: 0, max: 10, step: 1 };
  it.each([
    ["no criteria", { criteria: [] }],
    ["too many criteria", { criteria: Array.from({ length: 21 }, (_, i) => ({ ...base, key: `c${i}` })) }],
    ["duplicate keys", { criteria: [base, base] }],
    ["bad key", { criteria: [{ ...base, key: "A-1" }] }],
    ["min >= max", { criteria: [{ ...base, min: 5, max: 5 }] }],
    ["zero step", { criteria: [{ ...base, step: 0 }] }],
    ["max off grid", { criteria: [{ ...base, step: 3 }] }],
    ["too many steps", { criteria: [{ ...base, max: 100000, step: 1 }] }],
    ["non-finite", { criteria: [{ ...base, max: Number.POSITIVE_INFINITY }] }],
    ["zero weight", { criteria: [{ ...base, weight: 0 }] }],
    ["huge weight", { criteria: [{ ...base, weight: 101 }] }],
    ["unknown method", { criteria: [base], aggregation: { method: "mode" } }],
    ["trimmed without trim", { criteria: [base], aggregation: { method: "trimmed_mean" } }],
    ["trim too big", { criteria: [base], aggregation: { method: "trimmed_mean", trim: 6 } }],
    ["trim on mean", { criteria: [base], aggregation: { method: "weighted_mean", trim: 1 } }],
    ["bad normalization", { criteria: [base], normalization: "minmax" }],
    ["unknown tie criterion", { criteria: [base], tieBreakers: [{ type: "criterion", key: "zz" }] }],
    ["duplicate tie-breakers", { criteria: [base], tieBreakers: [{ type: "judge_count" }, { type: "judge_count" }] }],
    ["unknown tie type", { criteria: [base], tieBreakers: [{ type: "coin" }] }],
    ["not an object", "rubric"]
  ])("rejects %s", (_n, input) => {
    expect(() => parseRubric(input)).toThrowError(code("invalid_rubric"));
  });
});

describe("score values", () => {
  it("accepts values on the step grid", () => {
    expect(validateScoreValues(rubric(), { craft: 7.5, impact: 3 }, { complete: true })).toEqual({ craft: 7.5, impact: 3 });
    expect(validateScoreValues(rubric(), { craft: 0.1 + 0.2 + 0.2 }, { complete: false })).toEqual({ craft: 0.5 });
  });
  it.each([
    [{ craft: 7.25, impact: 1 }], [{ craft: -0.5, impact: 1 }], [{ craft: 10.5, impact: 1 }], [{ craft: "7", impact: 1 }],
    [{ craft: Number.NaN, impact: 1 }], [{ craft: 1, impact: 1, extra: 1 }], [[1, 2]]
  ])("rejects %j", values => {
    expect(() => validateScoreValues(rubric(), values, { complete: false })).toThrowError(code("invalid_score_values"));
  });
  it("requires every criterion on submit", () => {
    expect(validateScoreValues(rubric(), { craft: 1 }, { complete: false })).toEqual({ craft: 1 });
    expect(() => validateScoreValues(rubric(), { craft: 1 }, { complete: true })).toThrowError(code("score_incomplete"));
  });
  it("compares value sets exactly", () => {
    expect(sameValues({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValues({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValues({ a: 1 }, { a: 1.5 })).toBe(false);
  });
});

describe("sheet scores and aggregation", () => {
  it("weights criteria (weighted mean, or weighted sum for the sum method)", () => {
    expect(sheetScore(rubric(), { craft: 8, impact: 5 })).toBeCloseTo((16 + 5) / 3);
    expect(sheetScore(rubric({ aggregation: { method: "sum" } }), { craft: 8, impact: 5 })).toBe(21);
    expect(() => sheetScore(rubric(), { craft: 8 })).toThrowError(code("score_incomplete"));
  });

  it("aggregates with each method", () => {
    const xs = [9, 1, 5, 7, 3];
    expect(aggregate(xs, { method: "weighted_mean", trim: 0 })).toEqual({ value: 5, trimApplied: false });
    expect(aggregate(xs, { method: "sum", trim: 0 })!.value).toBe(25);
    expect(aggregate(xs, { method: "median", trim: 0 })!.value).toBe(5);
    expect(aggregate([1, 2, 3, 10], { method: "median", trim: 0 })!.value).toBe(2.5);
    expect(aggregate(xs, { method: "trimmed_mean", trim: 1 })).toEqual({ value: 5, trimApplied: true });
    expect(aggregate([1, 2, 30], { method: "trimmed_mean", trim: 1 })).toEqual({ value: 2, trimApplied: true });
    expect(aggregate([1, 30], { method: "trimmed_mean", trim: 1 })).toEqual({ value: 15.5, trimApplied: false });
    expect(aggregate([], { method: "sum", trim: 0 })).toBeNull();
    expect(median([3])).toBe(3);
  });

  it("z-normalizes per judge and neutralizes judges without spread", () => {
    const z = zScores([
      { judgeId: "harsh", score: 2 }, { judgeId: "harsh", score: 4 },
      { judgeId: "kind", score: 8 }, { judgeId: "kind", score: 10 },
      { judgeId: "flat", score: 5 }, { judgeId: "flat", score: 5 }, { judgeId: "solo", score: 9 }
    ]);
    expect(z).toEqual([-1, 1, -1, 1, 0, 0, 0]);
  });
});

describe("computeStandings", () => {
  it("ranks by aggregated score, includes unscored entries last and is input-order independent", () => {
    const sheets = [sheet("j1", "a", 8, 8), sheet("j2", "a", 6, 6), sheet("j1", "b", 10, 10), sheet("j2", "b", 9, 9)];
    const result = computeStandings({ rubric: rubric(), sheets, entryIds: ["c", "a", "b"] });
    expect(result.map(r => [r.entryId, r.rank, r.score])).toEqual([["b", 1, 9.5], ["a", 2, 7], ["c", null, null]]);
    expect(result[0]!.judgeCount).toBe(2);
    expect(result[0]!.criterionMeans).toEqual({ craft: 9.5, impact: 9.5 });
    expect(computeStandings({ rubric: rubric(), sheets: [...sheets].reverse(), entryIds: ["b", "c", "a"] })).toEqual(result);
  });

  it("shares ranks for unresolved ties (1, 1, 3)", () => {
    const result = computeStandings({ rubric: rubric(), entryIds: [], sheets: [sheet("j", "a", 5, 5), sheet("j", "b", 5, 5), sheet("j", "c", 1, 1)] });
    expect(result.map(r => [r.entryId, r.rank, r.tied])).toEqual([["a", 1, true], ["b", 1, true], ["c", 3, false]]);
  });

  it("breaks ties by criterion priority", () => {
    // Same weighted mean (craft weight 2): a = (2*6+3)/3 = 5, b = (2*4+7)/3 = 5.
    const r = rubric({ tieBreakers: [{ type: "criterion", key: "impact" }] });
    const result = computeStandings({ rubric: r, entryIds: [], sheets: [sheet("j", "a", 6, 3), sheet("j", "b", 4, 7)] });
    expect(result.map(x => [x.entryId, x.rank, x.tieBreak])).toEqual([["b", 1, "criterion:impact"], ["a", 2, "criterion:impact"]]);
  });

  it("breaks ties by judge count, then head judge", () => {
    const r = rubric({ aggregation: { method: "weighted_mean" }, tieBreakers: [{ type: "judge_count" }, { type: "head_judge" }] });
    const byCount = computeStandings({ rubric: r, entryIds: [], sheets: [sheet("j1", "a", 5, 5), sheet("j1", "b", 5, 5), sheet("j2", "b", 5, 5)] });
    expect(byCount.map(x => [x.entryId, x.rank, x.tieBreak])).toEqual([["b", 1, "judge_count"], ["a", 2, "judge_count"]]);
    const byHead = computeStandings({ rubric: r, entryIds: [], sheets: [
      sheet("h", "a", 4, 4, { headJudge: true }), sheet("j", "a", 6, 6),
      sheet("h", "b", 6, 6, { headJudge: true }), sheet("j", "b", 4, 4)
    ] });
    expect(byHead.map(x => [x.entryId, x.rank, x.tieBreak, x.headJudgeScore])).toEqual([["b", 1, "head_judge", 6], ["a", 2, "head_judge", 4]]);
  });

  it("an entry without a head-judge sheet loses the head-judge tie-break", () => {
    const r = rubric({ tieBreakers: [{ type: "head_judge" }] });
    const result = computeStandings({ rubric: r, entryIds: [], sheets: [sheet("j", "a", 5, 5), sheet("h", "b", 5, 5, { headJudge: true })] });
    expect(result.map(x => x.entryId)).toEqual(["b", "a"]);
  });

  it("supports sum, median and trimmed-mean aggregation", () => {
    const sheets = ["j1", "j2", "j3"].flatMap((j, i) => [sheet(j, "a", [10, 2, 3][i]!, [10, 2, 3][i]!), sheet(j, "b", 4, 4)]);
    const order = (method: Record<string, unknown>) => computeStandings({ rubric: rubric({ aggregation: method }), entryIds: [], sheets }).map(x => [x.entryId, x.score]);
    expect(order({ method: "weighted_mean" })).toEqual([["a", 5], ["b", 4]]);
    expect(order({ method: "sum" })).toEqual([["a", 45], ["b", 36]]);
    expect(order({ method: "median" })).toEqual([["b", 4], ["a", 3]]);
    expect(order({ method: "trimmed_mean", trim: 1 })).toEqual([["b", 4], ["a", 3]]);
  });

  it("z-score normalization removes a harsh judge's bias", () => {
    // Judge "harsh" scores everyone 4 points lower; raw means tie a and b only after normalization.
    const sheets = [
      sheet("harsh", "a", 1, 1), sheet("harsh", "b", 3, 3), sheet("kind", "a", 9, 9), sheet("kind", "b", 7, 7)
    ];
    const plain = computeStandings({ rubric: rubric(), entryIds: [], sheets });
    expect(plain.map(x => [x.entryId, x.score])).toEqual([["a", 5], ["b", 5]]);
    const normalized = computeStandings({ rubric: rubric({ normalization: "z_score" }), entryIds: [], sheets });
    expect(normalized.map(x => [x.entryId, x.score, x.rawScore])).toEqual([["a", 0, 5], ["b", 0, 5]]);
    const skewed = computeStandings({ rubric: rubric({ normalization: "z_score" }), entryIds: [], sheets: [...sheets, sheet("kind", "c", 8, 8), sheet("harsh", "c", 4, 4)] });
    expect(skewed[0]!.entryId).toBe("c");
  });

  it("sums performance scores across rounds for competition standings", () => {
    const result = computeStandings({ rubric: rubric(), entryIds: [], sheets: [
      sheet("j", "a", 5, 5, { performanceId: "r1a" }), sheet("j", "a", 6, 6, { performanceId: "r2a" }), sheet("j", "b", 10, 10, { performanceId: "r1b" })
    ] });
    expect(result.map(x => [x.entryId, x.score])).toEqual([["a", 11], ["b", 10]]);
  });

  it("is not swayed by floating-point noise", () => {
    const r = parseRubric({ criteria: [{ key: "x", label: "X", min: 0, max: 1, step: 0.1 }] });
    const result = computeStandings({ rubric: r, entryIds: [], sheets: [
      { judgeId: "j1", entryId: "a", performanceId: "pa", values: { x: 0.1 }, headJudge: false },
      { judgeId: "j2", entryId: "a", performanceId: "pa", values: { x: 0.2 }, headJudge: false },
      { judgeId: "j1", entryId: "b", performanceId: "pb", values: { x: 0.3 }, headJudge: false },
      { judgeId: "j2", entryId: "b", performanceId: "pb", values: { x: 0 }, headJudge: false }
    ] });
    expect(result.map(x => x.rank)).toEqual([1, 1]);
    expect(quantize(0.1 + 0.2)).toBe(0.3);
  });
});

describe("corrections", () => {
  it("must change something and be approved by someone else, once", () => {
    expect(() => assertCorrection({ a: 1 }, { a: 1 })).toThrowError(code("correction_unchanged"));
    expect(() => assertCorrection({ a: 1 }, { a: 2 })).not.toThrow();
    expect(() => assertCorrectionDecision("pending", "u1", "u1")).toThrowError(code("self_approval_forbidden"));
    expect(() => assertCorrectionDecision("approved", "u1", "u2")).toThrowError(code("invalid_state_correction_decided"));
    expect(() => assertCorrectionDecision("pending", "u1", "u2")).not.toThrow();
  });
});
