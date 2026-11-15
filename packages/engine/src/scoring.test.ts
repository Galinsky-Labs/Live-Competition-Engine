import test from "node:test";
import assert from "node:assert/strict";
import { parseContestConfig } from "./contest-config.ts";
import { aggregate, computeStandings, sheetTotal, validateScores } from "./scoring.ts";

const config = (scoring: object = {}, extra: object = {}) => parseContestConfig({
  scoring: { criteria: [{ key: "skill", label: "Skill", weight: 2, min: 0, max: 10, step: 0.5 }, { key: "style", label: "Style", weight: 1, min: 1, max: 5, step: 1 }], ...scoring },
  ...extra
});

test("score sheets are validated against criteria ranges and steps", () => {
  const c = config().scoring.criteria;
  assert.deepEqual(validateScores(c, { skill: 7.5, style: 3 }), { skill: 7.5, style: 3 });
  assert.throws(() => validateScores(c, { skill: 7.5 }), /missing_criterion_score/);
  assert.throws(() => validateScores(c, { skill: 11, style: 3 }), /score_out_of_range/);
  assert.throws(() => validateScores(c, { skill: 7.25, style: 3 }), /score_not_on_step/);
  assert.throws(() => validateScores(c, { skill: 7, style: 3, bonus: 1 }), /unknown_criterion/);
  assert.equal(sheetTotal(c, { skill: 10, style: 5 }), 100);
  assert.equal(sheetTotal(c, { skill: 0, style: 1 }), 0);
  assert.equal(Math.round(sheetTotal(c, { skill: 5, style: 3 })), 50);
});

test("aggregation methods", () => {
  assert.equal(aggregate("mean", [1, 2, 9]), 4);
  assert.equal(aggregate("median", [1, 2, 9]), 2);
  assert.equal(aggregate("trimmed_mean", [1, 2, 3, 100]), 2.5);
  assert.equal(aggregate("sum", [1, 2, 3]), 6);
});

const sheets = [
  { entryId: "A", judgeId: "j1", scores: { skill: 8, style: 4 }, performanceOrdinal: 1 },
  { entryId: "A", judgeId: "j2", scores: { skill: 6, style: 3 }, performanceOrdinal: 1 },
  { entryId: "B", judgeId: "j1", scores: { skill: 8, style: 3 }, performanceOrdinal: 2 },
  { entryId: "B", judgeId: "j2", scores: { skill: 6, style: 4 }, performanceOrdinal: 2 },
  { entryId: "C", judgeId: "j1", scores: { skill: 2, style: 1 }, performanceOrdinal: 3 }
];

test("standings are deterministic, flag incomplete panels and apply tie-break order", () => {
  const expected = new Map([["A", 2], ["B", 2], ["C", 2]]);
  const shared = computeStandings(config({ tieBreaks: ["shared_rank"] }), sheets, ["A", "B", "C"], expected);
  assert.deepEqual(shared.map(r => [r.entryId, r.rank]), [["A", 1], ["B", 1], ["C", 3]], "equal totals share rank");
  assert.equal(shared.find(r => r.entryId === "C")!.complete, false);
  const byOrder = computeStandings(config({ tieBreaks: ["earliest_performance"] }), sheets, ["B", "A", "C"], expected);
  assert.deepEqual(byOrder.map(r => [r.entryId, r.rank, r.tieBrokenBy]), [["A", 1, "earliest_performance"], ["B", 2, "earliest_performance"], ["C", 3, null]]);
  const again = computeStandings(config({ tieBreaks: ["earliest_performance"] }), [...sheets].reverse(), ["C", "B", "A"], expected);
  assert.deepEqual(again, byOrder, "input order does not change results");
});

test("audience weighting and judge normalization", () => {
  const expected = new Map([["A", 2], ["B", 2], ["C", 2]]);
  const mixed = computeStandings(config({ judgeWeight: 0.5, audienceWeight: 0.5, tieBreaks: ["shared_rank"] }), sheets, ["A", "B", "C"], expected, new Map([["A", 10], ["B", 90], ["C", 0]]));
  assert.equal(mixed[0]!.entryId, "B");
  const harsh = [
    { entryId: "A", judgeId: "lenient", scores: { skill: 10, style: 5 }, performanceOrdinal: 1 },
    { entryId: "B", judgeId: "lenient", scores: { skill: 9, style: 5 }, performanceOrdinal: 2 },
    { entryId: "A", judgeId: "harsh", scores: { skill: 1, style: 1 }, performanceOrdinal: 1 },
    { entryId: "B", judgeId: "harsh", scores: { skill: 3, style: 1 }, performanceOrdinal: 2 }
  ];
  const raw = computeStandings(config({ tieBreaks: ["shared_rank"] }), harsh, ["A", "B"], new Map());
  const z = computeStandings(config({ normalization: "judge_zscore", tieBreaks: ["shared_rank"] }), harsh, ["A", "B"], new Map());
  assert.equal(raw[0]!.entryId, "B");
  assert.equal(z[0]!.score, z[1]!.score, "after z-scoring each judge prefers a different entrant equally");
});
