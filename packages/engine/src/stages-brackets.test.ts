import test from "node:test";
import assert from "node:assert/strict";
import { planRoundRobin, planSingleElimination, seedPositions } from "./brackets.ts";
import { advancementRuleSchema, selectAdvancing, stageInputSchema } from "./stages.ts";

const standings = [
  { entryId: "a", score: 9, rank: 1 }, { entryId: "b", score: 8, rank: 2 },
  { entryId: "c", score: 8, rank: 2 }, { entryId: "d", score: 6, rank: 4 }
];

test("advancement contracts: top-n with and without ties, threshold, manual", () => {
  assert.deepEqual(selectAdvancing({ type: "top_n", count: 2, tiesAdvance: true }, standings), ["a", "b", "c"]);
  assert.deepEqual(selectAdvancing({ type: "top_n", count: 2, tiesAdvance: false }, standings), ["a", "b"]);
  assert.deepEqual(selectAdvancing({ type: "threshold", minScore: 8 }, standings), ["a", "b", "c"]);
  assert.deepEqual(selectAdvancing({ type: "manual" }, standings, ["d", "d", "a"]), ["d", "a"]);
  assert.throws(() => selectAdvancing({ type: "manual" }, standings, ["zzz"]), /manual_selection_not_in_stage/);
  assert.deepEqual(selectAdvancing({ type: "none" }, standings), []);
  assert.equal(advancementRuleSchema.safeParse({ type: "top_n", count: 0 }).success, false);
});

test("stage input: timed stages need a duration; bracket advancement needs head-to-head", () => {
  assert.equal(stageInputSchema.safeParse({ label: "Final", timed: true }).success, false);
  assert.equal(stageInputSchema.safeParse({ label: "Final", timed: true, durationSeconds: 180 }).success, true);
  assert.equal(stageInputSchema.safeParse({ label: "Bracket", advancement: { type: "bracket_winners" } }).success, false);
  assert.equal(stageInputSchema.safeParse({ label: "Bracket", format: "head_to_head", advancement: { type: "bracket_winners" } }).success, true);
});

test("seeded single elimination places top seeds apart and gives them byes", () => {
  assert.deepEqual(seedPositions(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const plan = planSingleElimination(["s1", "s2", "s3", "s4", "s5", "s6"]);
  assert.equal(plan.length, 7);
  const first = plan.filter(m => m.round === 1);
  assert.deepEqual(first.filter(m => m.byeWinner).map(m => m.byeWinner).sort(), ["s1", "s2"]);
  const semis = plan.filter(m => m.round === 2);
  assert.equal(semis[0]!.entryA, "s1");
  assert.equal(semis[1]!.entryA, "s2");
  assert.equal(plan.find(m => m.round === 3)!.next, null);
  assert.throws(() => planSingleElimination(["x", "x"]), /duplicate_entrant/);
  assert.throws(() => planSingleElimination(["x"]), /needs_two/);
});

test("round robin pairs everyone exactly once, odd counts rest in turn", () => {
  const pairs = planRoundRobin(["a", "b", "c", "d", "e"]);
  assert.equal(pairs.length, 10);
  const keys = new Set(pairs.map(p => [p.entryA, p.entryB].sort().join("-")));
  assert.equal(keys.size, 10);
  assert.equal(Math.max(...pairs.map(p => p.round)), 5);
});
