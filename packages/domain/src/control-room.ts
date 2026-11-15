/**
 * LC-25 run-of-show state machines. Pure.
 */
import { DomainError, isBoundedText } from "./index.ts";

export type ShowState = "standby" | "running" | "paused" | "ended";
export type RoundStatus = "scheduled" | "live" | "completed" | "cancelled";
export type PerformanceStatus = "queued" | "live" | "completed" | "skipped";

const showTransitions: Readonly<Record<ShowState, readonly ShowState[]>> = {
  standby: ["running", "ended"],
  running: ["paused", "ended"],
  paused: ["running", "ended"],
  ended: []
};

const roundTransitions: Readonly<Record<RoundStatus, readonly RoundStatus[]>> = {
  scheduled: ["live", "cancelled"],
  live: ["completed", "cancelled"],
  completed: [],
  cancelled: []
};

const performanceTransitions: Readonly<Record<PerformanceStatus, readonly PerformanceStatus[]>> = {
  queued: ["live", "skipped"],
  live: ["completed", "skipped"],
  completed: [],
  skipped: []
};

export function assertShowTransition(from: ShowState, to: ShowState): void {
  if (!showTransitions[from].includes(to)) throw new DomainError(`invalid_state_show_${from}_to_${to}`);
}

export function canTransitionRound(from: RoundStatus, to: RoundStatus): boolean {
  return roundTransitions[from].includes(to);
}

export function canTransitionPerformance(from: PerformanceStatus, to: PerformanceStatus): boolean {
  return performanceTransitions[from].includes(to);
}

export interface LineupRound {
  id: string;
  ordinal: number;
  status: RoundStatus;
  performances: ReadonlyArray<{ id: string; ordinal: number; status: PerformanceStatus }>;
}

/** Guard for a round transition given the whole lineup. */
export function assertRoundTransition(lineup: readonly LineupRound[], roundId: string, to: RoundStatus, show: ShowState): void {
  const round = lineup.find(candidate => candidate.id === roundId);
  if (!round) throw new DomainError("round_not_found");
  if (!canTransitionRound(round.status, to)) throw new DomainError(`invalid_state_round_${round.status}_to_${to}`);
  if (to === "live") {
    if (show === "ended") throw new DomainError("invalid_state_show_ended");
    if (lineup.some(other => other.id !== roundId && other.status === "live")) throw new DomainError("invalid_state_another_round_live");
  }
  if (to === "completed" && round.performances.some(p => p.status === "queued" || p.status === "live")) {
    throw new DomainError("invalid_state_round_has_pending_performances");
  }
  if (to === "cancelled" && round.performances.some(p => p.status === "live")) {
    throw new DomainError("invalid_state_round_has_live_performance");
  }
}

/** Guard for a performance transition given the whole lineup and the show state. */
export function assertPerformanceTransition(lineup: readonly LineupRound[], performanceId: string, to: PerformanceStatus, show: ShowState): void {
  const round = lineup.find(candidate => candidate.performances.some(p => p.id === performanceId));
  const performance = round?.performances.find(p => p.id === performanceId);
  if (!round || !performance) throw new DomainError("performance_not_found");
  if (!canTransitionPerformance(performance.status, to)) throw new DomainError(`invalid_state_performance_${performance.status}_to_${to}`);
  if (to === "live") {
    if (show !== "running") throw new DomainError(`invalid_state_show_${show}`);
    if (round.status !== "live") throw new DomainError("invalid_state_round_not_live");
    if (lineup.some(r => r.performances.some(p => p.status === "live"))) throw new DomainError("invalid_state_performance_already_live");
  }
}

/** Now = the live performance; next = first queued performance in lineup order of open rounds. */
export function nowAndNext(lineup: readonly LineupRound[]): { now: string | null; next: string | null } {
  const ordered = [...lineup]
    .filter(round => round.status === "live" || round.status === "scheduled")
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap(round => [...round.performances].sort((a, b) => a.ordinal - b.ordinal));
  const now = lineup.flatMap(round => round.performances).find(p => p.status === "live")?.id ?? null;
  const next = ordered.find(p => p.status === "queued")?.id ?? null;
  return { now, next };
}

/**
 * Plan a reorder of one round. `requested` must be a permutation of all its
 * performances; performances that already left the queue keep their position.
 * Returns the new 1-based ordinals.
 */
export function planReorder(
  current: ReadonlyArray<{ id: string; ordinal: number; status: PerformanceStatus }>,
  requested: readonly string[]
): Array<{ id: string; ordinal: number }> {
  const sorted = [...current].sort((a, b) => a.ordinal - b.ordinal);
  if (requested.length !== sorted.length || new Set(requested).size !== requested.length ||
    !requested.every(id => sorted.some(p => p.id === id))) {
    throw new DomainError("invalid_lineup_order");
  }
  sorted.forEach((performance, index) => {
    if (performance.status !== "queued" && requested[index] !== performance.id) {
      throw new DomainError("invalid_state_lineup_fixed_performance_moved");
    }
  });
  return requested.map((id, index) => ({ id, ordinal: index + 1 }));
}

export function normalizeReason(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("invalid_reason");
  const trimmed = value.trim();
  if (!isBoundedText(trimmed, 200, 1) || /[\n\t]/.test(trimmed)) throw new DomainError("invalid_reason");
  return trimmed;
}
