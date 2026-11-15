/**
 * LC-28 pure tally functions. Integer arithmetic only (weights and points are
 * integers), so results are exact and reproducible on any machine.
 *
 * Tie handling (deterministic, documented):
 * * Rows are ordered by score descending, then by the window's option order.
 * * Equal scores share a rank (standard competition ranking 1,1,3).
 * * `winners` are all options at rank 1 — a tie is reported, never broken randomly.
 * * With no counted weight there are no winners.
 * * Instant-runoff eliminates exactly one option per round: the lowest current total;
 *   ties at the bottom are broken by the lowest total in the most recent earlier round
 *   where they differ ("backwards" tie-break), then by the LATER option order.
 */
import { DomainError } from "./index.ts";

export type TallyMethod = "plurality" | "approval" | "points" | "borda" | "irv";
export const tallyMethods: readonly TallyMethod[] = ["plurality", "approval", "points", "borda", "irv"];

export type CanonicalChoice =
  | { optionId: string }
  | { optionIds: string[] }
  | { allocations: Record<string, number> }
  | { ranking: string[] };

export interface WeightedBallot {
  weight: number;
  choice: CanonicalChoice;
}

export interface TallyRow {
  optionId: string;
  score: number;
  rank: number;
}

export interface IrvRound {
  round: number;
  totals: Record<string, number>;
  exhausted: number;
  eliminated: string | null;
}

export interface TallyResult {
  method: TallyMethod;
  ballotCount: number;
  totalWeight: number;
  rows: TallyRow[];
  winners: string[];
  rounds?: IrvRound[];
}

function assertInputs(options: readonly string[], ballots: readonly WeightedBallot[]) {
  if (options.length === 0 || new Set(options).size !== options.length) throw new DomainError("invalid_tally_options");
  for (const ballot of ballots) {
    if (!Number.isSafeInteger(ballot.weight) || ballot.weight < 1) throw new DomainError("invalid_tally_ballot");
  }
}

/** Rank by score desc then option order; equal scores share a rank. */
export function rankScores(options: readonly string[], scores: ReadonlyMap<string, number>, totalWeight: number): { rows: TallyRow[]; winners: string[] } {
  const order = new Map(options.map((id, index) => [id, index]));
  const sorted = [...options].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || order.get(a)! - order.get(b)!);
  const rows = sorted.map(optionId => {
    const score = scores.get(optionId) ?? 0;
    return { optionId, score, rank: 1 + sorted.filter(other => (scores.get(other) ?? 0) > score).length };
  });
  return { rows, winners: totalWeight > 0 ? rows.filter(row => row.rank === 1).map(row => row.optionId) : [] };
}

function scoreWith(
  method: TallyMethod,
  options: readonly string[],
  ballots: readonly WeightedBallot[],
  points: (choice: CanonicalChoice, add: (optionId: string, value: number) => void) => void
): TallyResult {
  assertInputs(options, ballots);
  const known = new Set(options);
  const scores = new Map(options.map(id => [id, 0]));
  let totalWeight = 0;
  for (const ballot of ballots) {
    totalWeight += ballot.weight;
    points(ballot.choice, (optionId, value) => {
      if (!known.has(optionId)) throw new DomainError("invalid_tally_ballot");
      scores.set(optionId, scores.get(optionId)! + value * ballot.weight);
    });
  }
  return { method, ballotCount: ballots.length, totalWeight, ...rankScores(options, scores, totalWeight) };
}

export function tallyPlurality(options: readonly string[], ballots: readonly WeightedBallot[]): TallyResult {
  return scoreWith("plurality", options, ballots, (choice, add) => {
    if (!("optionId" in choice)) throw new DomainError("invalid_tally_ballot");
    add(choice.optionId, 1);
  });
}

export function tallyApproval(options: readonly string[], ballots: readonly WeightedBallot[]): TallyResult {
  return scoreWith("approval", options, ballots, (choice, add) => {
    if (!("optionIds" in choice) || new Set(choice.optionIds).size !== choice.optionIds.length) throw new DomainError("invalid_tally_ballot");
    for (const id of choice.optionIds) add(id, 1);
  });
}

export function tallyPoints(options: readonly string[], ballots: readonly WeightedBallot[]): TallyResult {
  return scoreWith("points", options, ballots, (choice, add) => {
    if (!("allocations" in choice)) throw new DomainError("invalid_tally_ballot");
    for (const [id, value] of Object.entries(choice.allocations)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("invalid_tally_ballot");
      add(id, value);
    }
  });
}

/** Borda count: with n options, rank position i (0-based) earns n-1-i points; unranked earn 0. */
export function tallyBorda(options: readonly string[], ballots: readonly WeightedBallot[]): TallyResult {
  const n = options.length;
  return scoreWith("borda", options, ballots, (choice, add) => {
    if (!("ranking" in choice) || new Set(choice.ranking).size !== choice.ranking.length) throw new DomainError("invalid_tally_ballot");
    choice.ranking.forEach((id, index) => add(id, n - 1 - index));
  });
}

export function tallyInstantRunoff(options: readonly string[], ballots: readonly WeightedBallot[]): TallyResult {
  assertInputs(options, ballots);
  const known = new Set(options);
  for (const ballot of ballots) {
    if (!("ranking" in ballot.choice) || new Set(ballot.choice.ranking).size !== ballot.choice.ranking.length ||
      ballot.choice.ranking.some(id => !known.has(id))) {
      throw new DomainError("invalid_tally_ballot");
    }
  }
  const order = new Map(options.map((id, index) => [id, index]));
  const totalWeight = ballots.reduce((sum, ballot) => sum + ballot.weight, 0);
  const continuing = new Set(options);
  const rounds: IrvRound[] = [];
  const eliminatedOrder: string[] = [];
  const lastScore = new Map<string, number>();
  let winners: string[] = [];

  while (continuing.size > 0) {
    const totals = new Map([...continuing].map(id => [id, 0]));
    let exhausted = 0;
    for (const ballot of ballots) {
      const top = (ballot.choice as { ranking: string[] }).ranking.find(id => continuing.has(id));
      if (top === undefined) exhausted += ballot.weight;
      else totals.set(top, totals.get(top)! + ballot.weight);
    }
    for (const [id, value] of totals) lastScore.set(id, value);
    const active = totalWeight - exhausted;
    const round: IrvRound = { round: rounds.length + 1, totals: Object.fromEntries(totals), exhausted, eliminated: null };
    rounds.push(round);
    const values = [...totals.values()];
    const max = Math.max(...values);
    if (active === 0) {
      winners = [];
      break;
    }
    if (max * 2 > active) {
      winners = [...totals].filter(([, value]) => value === max).map(([id]) => id);
      break;
    }
    if (values.every(value => value === max)) {
      winners = [...continuing].sort((a, b) => order.get(a)! - order.get(b)!);
      break;
    }
    const min = Math.min(...values);
    let candidates = [...totals].filter(([, value]) => value === min).map(([id]) => id);
    for (let back = rounds.length - 2; back >= 0 && candidates.length > 1; back--) {
      const earlier = rounds[back]!.totals;
      const lowest = Math.min(...candidates.map(id => earlier[id] ?? 0));
      candidates = candidates.filter(id => (earlier[id] ?? 0) === lowest);
    }
    const loser = candidates.sort((a, b) => order.get(b)! - order.get(a)!)[0]!;
    round.eliminated = loser;
    continuing.delete(loser);
    eliminatedOrder.push(loser);
  }

  // Final order: winners (tied at rank 1), then remaining continuing, then reverse elimination order.
  const remaining = [...continuing].filter(id => !winners.includes(id))
    .sort((a, b) => (lastScore.get(b) ?? 0) - (lastScore.get(a) ?? 0) || order.get(a)! - order.get(b)!);
  const sortedWinners = [...winners].sort((a, b) => order.get(a)! - order.get(b)!);
  const rows: TallyRow[] = [
    ...sortedWinners.map(optionId => ({ optionId, score: lastScore.get(optionId) ?? 0, rank: 1 })),
    // Options still continuing when a majority was reached share ranks by their final-round total.
    ...remaining.map(optionId => ({
      optionId,
      score: lastScore.get(optionId) ?? 0,
      rank: sortedWinners.length + 1 + remaining.filter(other => (lastScore.get(other) ?? 0) > (lastScore.get(optionId) ?? 0)).length
    })),
    // Eliminated options rank by elimination order: eliminated later ranks higher.
    ...[...eliminatedOrder].reverse().map((optionId, index) => ({
      optionId, score: lastScore.get(optionId) ?? 0, rank: sortedWinners.length + remaining.length + index + 1
    }))
  ];
  winners = sortedWinners;
  return { method: "irv", ballotCount: ballots.length, totalWeight, rows, winners, rounds };
}

export function tallyBallots(method: TallyMethod, options: readonly string[], ballots: readonly WeightedBallot[]): TallyResult {
  switch (method) {
    case "plurality": return tallyPlurality(options, ballots);
    case "approval": return tallyApproval(options, ballots);
    case "points": return tallyPoints(options, ballots);
    case "borda": return tallyBorda(options, ballots);
    case "irv": return tallyInstantRunoff(options, ballots);
    default: throw new DomainError("invalid_tally_method");
  }
}
