/**
 * LC-28 voting rules: window definitions, ballot validation, eligibility,
 * weighting, phase and result visibility. Pure; the clock is passed in.
 */
import { createHash } from "node:crypto";
import { DomainError, isBoundedText, isUuid } from "./index.ts";
import type { CanonicalChoice, TallyMethod } from "./voting-tally.ts";

export type BallotType = "single" | "approval" | "distributed" | "ranked";
export type EligibilityRule = "any_member" | "entitled" | "joined_before_open";
export type WeightingRule = "equal" | "verified";
export type ResultVisibility = "hidden_until_close" | "live" | "never_public";
export type WindowStatus = "draft" | "published" | "closed" | "cancelled";
export type WindowPhase = "draft" | "scheduled" | "open" | "ended" | "closed" | "cancelled";

const ballotTypes: readonly BallotType[] = ["single", "approval", "distributed", "ranked"];
const eligibilityRules: readonly EligibilityRule[] = ["any_member", "entitled", "joined_before_open"];
const weightingRules: readonly WeightingRule[] = ["equal", "verified"];
const resultVisibilities: readonly ResultVisibility[] = ["hidden_until_close", "live", "never_public"];

/** Which tally methods each ballot type supports. */
export const allowedTallyMethods: Readonly<Record<BallotType, readonly TallyMethod[]>> = {
  single: ["plurality"],
  approval: ["approval"],
  distributed: ["points"],
  ranked: ["borda", "irv"]
};

export const VOTING_LIMITS = {
  minOptions: 2,
  maxOptions: 100,
  labelMaxLength: 120,
  maxPoints: 1000,
  maxSelections: 50,
  maxVerifiedWeight: 10,
  maxWindowMs: 30 * 24 * 60 * 60 * 1000,
  idempotencyKeyPattern: /^[A-Za-z0-9_-]{8,128}$/
} as const;

export interface VoteRules {
  ballotType: BallotType;
  tallyMethod: TallyMethod;
  eligibility: EligibilityRule;
  excludeParticipants: boolean;
  weighting: WeightingRule;
  verifiedWeight: number;
  maxPoints: number | null;
  maxSelections: number | null;
  resultVisibility: ResultVisibility;
  allowChange: boolean;
}

export interface VoteOptionInput {
  entryId: string;
  performanceId: string | null;
  label: string;
}

export interface VoteWindowDefinition {
  label: string;
  roundId: string | null;
  opensAt: Date;
  closesAt: Date;
  rules: VoteRules;
  options: VoteOptionInput[];
}

const parseDate = (value: unknown, code: string): Date => {
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new DomainError(code);
  return date;
};

export function validateVoteRules(input: Record<string, unknown>): VoteRules {
  const ballotType = (input.ballotType ?? "single") as BallotType;
  if (!ballotTypes.includes(ballotType)) throw new DomainError("invalid_ballot_type");
  const tallyMethod = (input.tallyMethod ?? allowedTallyMethods[ballotType][0]) as TallyMethod;
  if (!allowedTallyMethods[ballotType].includes(tallyMethod)) throw new DomainError("invalid_tally_method");
  const eligibility = (input.eligibility ?? "any_member") as EligibilityRule;
  if (!eligibilityRules.includes(eligibility)) throw new DomainError("invalid_eligibility");
  const excludeParticipants = input.excludeParticipants ?? true;
  if (typeof excludeParticipants !== "boolean") throw new DomainError("invalid_eligibility");
  const weighting = (input.weighting ?? "equal") as WeightingRule;
  if (!weightingRules.includes(weighting)) throw new DomainError("invalid_weighting");
  const verifiedWeight = input.verifiedWeight ?? (weighting === "verified" ? 2 : 1);
  if (!Number.isInteger(verifiedWeight) || (verifiedWeight as number) < 1 || (verifiedWeight as number) > VOTING_LIMITS.maxVerifiedWeight ||
    (weighting === "equal" && verifiedWeight !== 1)) {
    throw new DomainError("invalid_weighting");
  }
  let maxPoints: number | null = null;
  let maxSelections: number | null = null;
  if (ballotType === "distributed") {
    maxPoints = input.maxPoints as number;
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > VOTING_LIMITS.maxPoints) throw new DomainError("invalid_max_points");
  } else if (input.maxPoints !== undefined && input.maxPoints !== null) {
    throw new DomainError("invalid_max_points");
  }
  if (ballotType === "approval" || ballotType === "ranked") {
    maxSelections = (input.maxSelections ?? VOTING_LIMITS.maxSelections) as number;
    if (!Number.isInteger(maxSelections) || maxSelections < 1 || maxSelections > VOTING_LIMITS.maxSelections) {
      throw new DomainError("invalid_max_selections");
    }
  } else if (input.maxSelections !== undefined && input.maxSelections !== null) {
    throw new DomainError("invalid_max_selections");
  }
  const resultVisibility = (input.resultVisibility ?? "hidden_until_close") as ResultVisibility;
  if (!resultVisibilities.includes(resultVisibility)) throw new DomainError("invalid_result_visibility");
  const allowChange = input.allowChange ?? false;
  if (typeof allowChange !== "boolean") throw new DomainError("invalid_allow_change");
  return {
    ballotType, tallyMethod, eligibility, excludeParticipants, weighting,
    verifiedWeight: verifiedWeight as number, maxPoints, maxSelections, resultVisibility, allowChange
  };
}

export function validateVoteWindow(input: Record<string, unknown>): VoteWindowDefinition {
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!isBoundedText(label, VOTING_LIMITS.labelMaxLength, 1)) throw new DomainError("invalid_label");
  const roundId = input.roundId ?? null;
  if (roundId !== null && !isUuid(roundId)) throw new DomainError("invalid_round");
  const opensAt = parseDate(input.opensAt, "invalid_schedule");
  const closesAt = parseDate(input.closesAt, "invalid_schedule");
  if (closesAt.getTime() <= opensAt.getTime() || closesAt.getTime() - opensAt.getTime() > VOTING_LIMITS.maxWindowMs) {
    throw new DomainError("invalid_schedule");
  }
  const rules = validateVoteRules(input);
  const raw = input.options;
  if (!Array.isArray(raw) || raw.length < VOTING_LIMITS.minOptions || raw.length > VOTING_LIMITS.maxOptions) {
    throw new DomainError("invalid_options");
  }
  const options = raw.map(option => {
    const value = (option ?? {}) as Record<string, unknown>;
    const optionLabel = typeof value.label === "string" ? value.label.trim() : "";
    const performanceId = value.performanceId ?? null;
    if (!isUuid(value.entryId) || (performanceId !== null && !isUuid(performanceId)) ||
      !isBoundedText(optionLabel, VOTING_LIMITS.labelMaxLength, 1)) {
      throw new DomainError("invalid_options");
    }
    return { entryId: value.entryId, performanceId: performanceId as string | null, label: optionLabel };
  });
  const keys = new Set(options.map(option => `${option.entryId}:${option.performanceId ?? ""}`));
  if (keys.size !== options.length) throw new DomainError("invalid_options");
  if (rules.maxSelections !== null && rules.maxSelections > options.length) rules.maxSelections = options.length;
  return { label, roundId: roundId as string | null, opensAt, closesAt, rules, options };
}

/**
 * Validate a submitted choice against the window rules and option ids and return
 * its canonical form (sorted where order carries no meaning).
 */
export function validateBallotChoice(rules: Pick<VoteRules, "ballotType" | "maxPoints" | "maxSelections">, optionIds: readonly string[], input: unknown): CanonicalChoice {
  const known = new Set(optionIds);
  const value = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const fail = (): never => { throw new DomainError("invalid_ballot"); };
  switch (rules.ballotType) {
    case "single": {
      if (typeof value.optionId !== "string" || !known.has(value.optionId)) fail();
      return { optionId: value.optionId as string };
    }
    case "approval": {
      const ids = value.optionIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > (rules.maxSelections ?? 0) ||
        ids.some(id => typeof id !== "string" || !known.has(id)) || new Set(ids).size !== ids.length) fail();
      return { optionIds: [...(ids as string[])].sort() };
    }
    case "distributed": {
      const allocations = value.allocations;
      if (!allocations || typeof allocations !== "object" || Array.isArray(allocations)) fail();
      const entries = Object.entries(allocations as Record<string, unknown>);
      if (entries.length < 1 || entries.some(([id, points]) => !known.has(id) || !Number.isInteger(points) || (points as number) < 1)) fail();
      const total = entries.reduce((sum, [, points]) => sum + (points as number), 0);
      if (total > (rules.maxPoints ?? 0)) fail();
      return { allocations: Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))) as Record<string, number> };
    }
    case "ranked": {
      const ranking = value.ranking;
      if (!Array.isArray(ranking) || ranking.length < 1 || ranking.length > (rules.maxSelections ?? 0) ||
        ranking.some(id => typeof id !== "string" || !known.has(id)) || new Set(ranking).size !== ranking.length) fail();
      return { ranking: [...(ranking as string[])] };
    }
    default:
      return fail();
  }
}

/** Deterministic JSON for a canonical choice (keys sorted). */
export function canonicalChoiceJson(choice: CanonicalChoice): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sortKeys(v)]));
    }
    return value;
  };
  return JSON.stringify(sortKeys(choice));
}

/** Ballot commitment: sha256(receipt || choice || weight || salt) with unambiguous separators. */
export function ballotCommitment(receipt: string, choice: CanonicalChoice, weight: number, salt: string): string {
  return createHash("sha256")
    .update(`lce-ballot-v1\n${receipt}\n${canonicalChoiceJson(choice)}\n${weight}\n${salt}`, "utf8")
    .digest("hex");
}

export function voteWindowPhase(status: WindowStatus, opensAt: Date, closesAt: Date, now: Date): WindowPhase {
  if (status === "draft" || status === "closed" || status === "cancelled") return status;
  if (now.getTime() < opensAt.getTime()) return "scheduled";
  if (now.getTime() < closesAt.getTime()) return "open";
  return "ended";
}

export interface EligibilityFacts {
  membershipActive: boolean;
  membershipCreatedAt: Date;
  windowOpensAt: Date;
  hasEventViewEntitlement: boolean;
  isEntrantOrJudge: boolean;
}

export type EligibilityReason = "eligible" | "not_member" | "no_entitlement" | "joined_after_open" | "participant_excluded";

export function evaluateEligibility(rules: Pick<VoteRules, "eligibility" | "excludeParticipants">, facts: EligibilityFacts): { eligible: boolean; reason: EligibilityReason } {
  if (!facts.membershipActive) return { eligible: false, reason: "not_member" };
  if (rules.excludeParticipants && facts.isEntrantOrJudge) return { eligible: false, reason: "participant_excluded" };
  if (rules.eligibility === "entitled" && !facts.hasEventViewEntitlement) return { eligible: false, reason: "no_entitlement" };
  if (rules.eligibility === "joined_before_open" && facts.membershipCreatedAt.getTime() >= facts.windowOpensAt.getTime()) {
    return { eligible: false, reason: "joined_after_open" };
  }
  return { eligible: true, reason: "eligible" };
}

export function ballotWeight(rules: Pick<VoteRules, "weighting" | "verifiedWeight">, isVerified: boolean): number {
  return rules.weighting === "verified" && isVerified ? rules.verifiedWeight : 1;
}

/** Managers always see results; the public rule depends on the configured visibility. */
export function canViewVoteResults(visibility: ResultVisibility, phase: WindowPhase, isManager: boolean): boolean {
  if (isManager) return true;
  if (visibility === "never_public") return false;
  if (visibility === "live") return phase === "open" || phase === "ended" || phase === "closed";
  return phase === "closed";
}

export type WindowAction = "publish" | "cancel";

export function nextWindowStatus(current: WindowStatus, action: WindowAction | "close", phase: WindowPhase): WindowStatus {
  if (action === "publish" && current === "draft") return "published";
  if (action === "cancel" && (current === "draft" || current === "published")) return "cancelled";
  if (action === "close" && current === "published" && phase !== "scheduled") return "closed";
  throw new DomainError("invalid_state_transition");
}
