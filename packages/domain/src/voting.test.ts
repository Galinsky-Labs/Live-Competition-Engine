import { describe, expect, it } from "vitest";
import {
  ballotCommitment,
  ballotWeight,
  canonicalChoiceJson,
  canViewVoteResults,
  evaluateEligibility,
  nextWindowStatus,
  validateBallotChoice,
  validateVoteRules,
  validateVoteWindow,
  voteWindowPhase
} from "./voting";

const e1 = "00000000-0000-4000-8000-000000000001";
const e2 = "00000000-0000-4000-8000-000000000002";
const e3 = "00000000-0000-4000-8000-000000000003";
const opensAt = new Date("2026-11-15T12:00:00.000Z");
const closesAt = new Date("2026-11-15T13:00:00.000Z");
const windowInput = (extra: Record<string, unknown> = {}) => ({
  label: "Final vote",
  opensAt: opensAt.toISOString(),
  closesAt: closesAt.toISOString(),
  options: [{ entryId: e1, label: "One" }, { entryId: e2, label: "Two" }, { entryId: e3, label: "Three" }],
  ...extra
});

describe("vote window definition", () => {
  it("applies safe defaults", () => {
    const window = validateVoteWindow(windowInput());
    expect(window.rules).toEqual({
      ballotType: "single", tallyMethod: "plurality", eligibility: "any_member", excludeParticipants: true,
      weighting: "equal", verifiedWeight: 1, maxPoints: null, maxSelections: null,
      resultVisibility: "hidden_until_close", allowChange: false
    });
    expect(window.options[0]).toEqual({ entryId: e1, performanceId: null, label: "One" });
  });

  it("rejects invalid schedules, options and rule combinations", () => {
    expect(() => validateVoteWindow(windowInput({ closesAt: opensAt.toISOString() }))).toThrow("invalid_schedule");
    expect(() => validateVoteWindow(windowInput({ opensAt: "soon" }))).toThrow("invalid_schedule");
    expect(() => validateVoteWindow(windowInput({ closesAt: new Date(opensAt.getTime() + 31 * 86_400_000).toISOString() }))).toThrow("invalid_schedule");
    expect(() => validateVoteWindow(windowInput({ options: [{ entryId: e1, label: "One" }] }))).toThrow("invalid_options");
    expect(() => validateVoteWindow(windowInput({ options: [{ entryId: e1, label: "One" }, { entryId: e1, label: "Again" }] }))).toThrow("invalid_options");
    expect(() => validateVoteWindow(windowInput({ label: "" }))).toThrow("invalid_label");
    expect(() => validateVoteWindow(windowInput({ roundId: "x" }))).toThrow("invalid_round");
    expect(() => validateVoteRules({ ballotType: "single", tallyMethod: "borda" })).toThrow("invalid_tally_method");
    expect(() => validateVoteRules({ ballotType: "distributed" })).toThrow("invalid_max_points");
    expect(() => validateVoteRules({ ballotType: "single", maxPoints: 3 })).toThrow("invalid_max_points");
    expect(() => validateVoteRules({ ballotType: "single", maxSelections: 3 })).toThrow("invalid_max_selections");
    expect(() => validateVoteRules({ weighting: "equal", verifiedWeight: 3 })).toThrow("invalid_weighting");
    expect(() => validateVoteRules({ weighting: "verified", verifiedWeight: 11 })).toThrow("invalid_weighting");
    expect(() => validateVoteRules({ eligibility: "everyone" })).toThrow("invalid_eligibility");
    expect(() => validateVoteRules({ resultVisibility: "sometimes" })).toThrow("invalid_result_visibility");
    expect(() => validateVoteRules({ allowChange: "yes" })).toThrow("invalid_allow_change");
    expect(validateVoteRules({ ballotType: "ranked", tallyMethod: "irv" }).maxSelections).toBe(50);
    expect(validateVoteWindow(windowInput({ ballotType: "ranked", tallyMethod: "irv" })).rules.maxSelections).toBe(3);
  });
});

describe("ballot validation", () => {
  const ids = ["a", "b", "c"];
  it("single choice", () => {
    expect(validateBallotChoice({ ballotType: "single", maxPoints: null, maxSelections: null }, ids, { optionId: "b" })).toEqual({ optionId: "b" });
    expect(() => validateBallotChoice({ ballotType: "single", maxPoints: null, maxSelections: null }, ids, { optionId: "z" })).toThrow("invalid_ballot");
    expect(() => validateBallotChoice({ ballotType: "single", maxPoints: null, maxSelections: null }, ids, null)).toThrow("invalid_ballot");
  });
  it("approval is sorted, unique and bounded", () => {
    const rules = { ballotType: "approval" as const, maxPoints: null, maxSelections: 2 };
    expect(validateBallotChoice(rules, ids, { optionIds: ["c", "a"] })).toEqual({ optionIds: ["a", "c"] });
    expect(() => validateBallotChoice(rules, ids, { optionIds: ["a", "b", "c"] })).toThrow("invalid_ballot");
    expect(() => validateBallotChoice(rules, ids, { optionIds: ["a", "a"] })).toThrow("invalid_ballot");
    expect(() => validateBallotChoice(rules, ids, { optionIds: [] })).toThrow("invalid_ballot");
  });
  it("distributed points must be positive integers within the budget", () => {
    const rules = { ballotType: "distributed" as const, maxPoints: 5, maxSelections: null };
    expect(validateBallotChoice(rules, ids, { allocations: { c: 2, a: 3 } })).toEqual({ allocations: { a: 3, c: 2 } });
    expect(() => validateBallotChoice(rules, ids, { allocations: { a: 6 } })).toThrow("invalid_ballot");
    expect(() => validateBallotChoice(rules, ids, { allocations: { a: 0 } })).toThrow("invalid_ballot");
    expect(() => validateBallotChoice(rules, ids, { allocations: { a: 1.5 } })).toThrow("invalid_ballot");
    expect(() => validateBallotChoice(rules, ids, { allocations: { z: 1 } })).toThrow("invalid_ballot");
    expect(() => validateBallotChoice(rules, ids, { allocations: [] })).toThrow("invalid_ballot");
  });
  it("ranked keeps order and rejects duplicates", () => {
    const rules = { ballotType: "ranked" as const, maxPoints: null, maxSelections: 3 };
    expect(validateBallotChoice(rules, ids, { ranking: ["c", "a"] })).toEqual({ ranking: ["c", "a"] });
    expect(() => validateBallotChoice(rules, ids, { ranking: ["a", "a"] })).toThrow("invalid_ballot");
  });
});

describe("commitments", () => {
  it("are deterministic, key-order independent and bind every field", () => {
    const a = ballotCommitment("r", { allocations: { a: 1, b: 2 } }, 1, "s");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ballotCommitment("r", { allocations: { b: 2, a: 1 } }, 1, "s")).toBe(a);
    expect(ballotCommitment("r2", { allocations: { a: 1, b: 2 } }, 1, "s")).not.toBe(a);
    expect(ballotCommitment("r", { allocations: { a: 1, b: 2 } }, 2, "s")).not.toBe(a);
    expect(ballotCommitment("r", { allocations: { a: 1, b: 2 } }, 1, "t")).not.toBe(a);
    expect(canonicalChoiceJson({ ranking: ["b", "a"] })).toBe('{"ranking":["b","a"]}');
  });
});

describe("phase, eligibility, weighting and visibility", () => {
  it("derives the phase from status and server time", () => {
    expect(voteWindowPhase("draft", opensAt, closesAt, opensAt)).toBe("draft");
    expect(voteWindowPhase("published", opensAt, closesAt, new Date(opensAt.getTime() - 1))).toBe("scheduled");
    expect(voteWindowPhase("published", opensAt, closesAt, opensAt)).toBe("open");
    expect(voteWindowPhase("published", opensAt, closesAt, closesAt)).toBe("ended");
    expect(voteWindowPhase("closed", opensAt, closesAt, opensAt)).toBe("closed");
  });

  it("enforces explicit window transitions", () => {
    expect(nextWindowStatus("draft", "publish", "draft")).toBe("published");
    expect(nextWindowStatus("published", "close", "open")).toBe("closed");
    expect(nextWindowStatus("published", "close", "ended")).toBe("closed");
    expect(() => nextWindowStatus("published", "close", "scheduled")).toThrow("invalid_state_transition");
    expect(() => nextWindowStatus("closed", "cancel", "closed")).toThrow("invalid_state_transition");
    expect(() => nextWindowStatus("draft", "close", "draft")).toThrow("invalid_state_transition");
  });

  const facts = {
    membershipActive: true,
    membershipCreatedAt: new Date(opensAt.getTime() - 1000),
    windowOpensAt: opensAt,
    hasEventViewEntitlement: false,
    isEntrantOrJudge: false
  };
  it("evaluates every eligibility rule", () => {
    expect(evaluateEligibility({ eligibility: "any_member", excludeParticipants: true }, facts)).toEqual({ eligible: true, reason: "eligible" });
    expect(evaluateEligibility({ eligibility: "any_member", excludeParticipants: true }, { ...facts, membershipActive: false }).reason).toBe("not_member");
    expect(evaluateEligibility({ eligibility: "entitled", excludeParticipants: false }, facts).reason).toBe("no_entitlement");
    expect(evaluateEligibility({ eligibility: "entitled", excludeParticipants: false }, { ...facts, hasEventViewEntitlement: true }).eligible).toBe(true);
    expect(evaluateEligibility({ eligibility: "joined_before_open", excludeParticipants: false }, { ...facts, membershipCreatedAt: opensAt }).reason).toBe("joined_after_open");
    expect(evaluateEligibility({ eligibility: "any_member", excludeParticipants: true }, { ...facts, isEntrantOrJudge: true }).reason).toBe("participant_excluded");
    expect(evaluateEligibility({ eligibility: "any_member", excludeParticipants: false }, { ...facts, isEntrantOrJudge: true }).eligible).toBe(true);
  });

  it("weights verified members only under the verified rule", () => {
    expect(ballotWeight({ weighting: "equal", verifiedWeight: 1 }, true)).toBe(1);
    expect(ballotWeight({ weighting: "verified", verifiedWeight: 3 }, true)).toBe(3);
    expect(ballotWeight({ weighting: "verified", verifiedWeight: 3 }, false)).toBe(1);
  });

  it("applies the result visibility rule", () => {
    expect(canViewVoteResults("never_public", "closed", false)).toBe(false);
    expect(canViewVoteResults("never_public", "open", true)).toBe(true);
    expect(canViewVoteResults("live", "open", false)).toBe(true);
    expect(canViewVoteResults("live", "scheduled", false)).toBe(false);
    expect(canViewVoteResults("hidden_until_close", "ended", false)).toBe(false);
    expect(canViewVoteResults("hidden_until_close", "closed", false)).toBe(true);
  });
});
