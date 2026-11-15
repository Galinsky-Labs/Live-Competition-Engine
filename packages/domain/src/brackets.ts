import { DomainError } from "./index.ts";

/**
 * LC-16 optional head-to-head model: match lifecycle and deterministic seeded
 * single-elimination generation with byes. Pure; nothing else in the engine
 * depends on brackets.
 */
export const MATCH_STATUSES = ["scheduled", "live", "decided", "void"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export type MatchAction = "start" | "decide" | "void";

const ACTION_TARGET: Record<MatchAction, MatchStatus> = { start: "live", decide: "decided", void: "void" };
const MATCH_TRANSITIONS: Readonly<Record<MatchStatus, readonly MatchStatus[]>> = {
  scheduled: ["live", "void"],
  live: ["decided", "void"],
  decided: [],
  void: []
};

export function isMatchAction(value: unknown): value is MatchAction {
  return value === "start" || value === "decide" || value === "void";
}

/**
 * Validate a match action against the lifecycle:
 * scheduled → live → decided, and scheduled|live → void. Starting needs every
 * side present (at least two); deciding needs a winner slot among the sides.
 */
export function planMatchAction(
  status: MatchStatus,
  action: MatchAction,
  context: { filledSlots: readonly number[]; expectedSides: number; winnerSlot?: number | null; reason?: string | null }
): MatchStatus {
  const target = ACTION_TARGET[action];
  if (!MATCH_TRANSITIONS[status].includes(target)) throw new DomainError("invalid_state_match_transition");
  if (action === "start" && (context.filledSlots.length < Math.max(2, context.expectedSides))) {
    throw new DomainError("invalid_state_match_sides_incomplete");
  }
  if (action === "decide" && (context.winnerSlot === null || context.winnerSlot === undefined ||
    !context.filledSlots.includes(context.winnerSlot))) {
    throw new DomainError("invalid_match_winner");
  }
  if (action === "void" && (typeof context.reason !== "string" || !context.reason.trim() || context.reason.length > 1000)) {
    throw new DomainError("void_reason_required");
  }
  return target;
}

/** Standard bracket seed order: 1 and 2 can only meet in the final (e.g. 8 → 1,8,4,5,2,7,3,6). */
export function seedOrder(size: number): number[] {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) throw new DomainError("invalid_bracket_size");
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap(seed => [seed, n + 1 - seed]);
  }
  return order;
}

export interface SeededSide {
  /** Opaque side identity (an entry or a team id). */
  key: string;
  seed: number;
}

export interface PlannedSide {
  slot: 0 | 1;
  key: string;
  seed: number;
}

export interface PlannedMatch {
  round: number;
  position: number;
  sides: PlannedSide[];
  status: "scheduled" | "decided";
  bye: boolean;
  winnerSlot: 0 | 1 | null;
  next: { round: number; position: number; slot: 0 | 1 } | null;
}

export interface PlannedBracket {
  size: number;
  rounds: number;
  matches: PlannedMatch[];
}

export const MAX_BRACKET_SIDES = 256;

/**
 * Seeded single elimination. Seeds must be exactly 1..N (N ≥ 2). The bracket size
 * is the next power of two; missing seeds are byes, which fall to the top seeds.
 * Bye matches are created already decided and their side advanced into round 2.
 */
export function generateSingleElimination(input: readonly SeededSide[]): PlannedBracket {
  const n = input.length;
  if (n < 2 || n > MAX_BRACKET_SIDES) throw new DomainError("invalid_bracket_size");
  const bySeed = new Map<number, SeededSide>();
  const keys = new Set<string>();
  for (const side of input) {
    if (!Number.isInteger(side.seed) || side.seed < 1 || side.seed > n || bySeed.has(side.seed) ||
      typeof side.key !== "string" || !side.key || keys.has(side.key)) {
      throw new DomainError("invalid_bracket_seeds");
    }
    bySeed.set(side.seed, side);
    keys.add(side.key);
  }
  let size = 2;
  while (size < n) size *= 2;
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const matches: PlannedMatch[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const count = size / 2 ** round;
    for (let position = 0; position < count; position += 1) {
      matches.push({
        round, position, sides: [], status: "scheduled", bye: false, winnerSlot: null,
        next: round < rounds ? { round: round + 1, position: Math.floor(position / 2), slot: (position % 2) as 0 | 1 } : null
      });
    }
  }
  const find = (round: number, position: number) => matches.find(m => m.round === round && m.position === position)!;
  for (let position = 0; position < size / 2; position += 1) {
    const match = find(1, position);
    for (const slot of [0, 1] as const) {
      const side = bySeed.get(order[position * 2 + slot]!);
      if (side) match.sides.push({ slot, key: side.key, seed: side.seed });
    }
    if (match.sides.length === 1) {
      const only = match.sides[0]!;
      match.bye = true;
      match.status = "decided";
      match.winnerSlot = only.slot;
      const next = match.next!;
      find(next.round, next.position).sides.push({ slot: next.slot, key: only.key, seed: only.seed });
    }
  }
  for (const match of matches) match.sides.sort((a, b) => a.slot - b.slot);
  return { size, rounds, matches };
}
