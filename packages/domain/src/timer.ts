/**
 * LC-24 server-authoritative stage timer. Pure and deterministic: the state is
 * derived ONLY by replaying the ordered command log with server timestamps.
 *
 *   idle --start--> running --pause--> paused --resume--> running
 *   any  --reset--> idle          extend: idle | running | paused (bounded)
 *
 * "overtime" is a derived phase: running (or paused) with remaining <= 0.
 */
import { DomainError } from "./index.ts";

export const timerCommandTypes = ["start", "pause", "resume", "extend", "reset"] as const;
export type TimerCommandType = (typeof timerCommandTypes)[number];
export type TimerStatus = "idle" | "running" | "paused";
export type TimerPhase = "idle" | "running" | "paused" | "overtime";

export const TIMER_LIMITS = {
  minDurationMs: 1_000,
  maxDurationMs: 6 * 60 * 60 * 1000,
  minExtendMs: 1_000,
  maxExtendStepMs: 10 * 60 * 1000,
  maxTotalExtensionMs: 60 * 60 * 1000,
  maxCommands: 1_000,
  maxReasonLength: 200
} as const;

export interface TimerCommand {
  type: TimerCommandType;
  /** Server time in epoch milliseconds. */
  at: number;
  amountMs?: number | null;
  durationMs?: number | null;
  reason?: string | null;
}

export interface TimerConfig {
  durationMs: number;
  maxExtensionMs: number;
}

export interface TimerState {
  status: TimerStatus;
  durationMs: number;
  extendedMs: number;
  maxExtensionMs: number;
  /** Elapsed time accumulated before the current running segment. */
  elapsedBeforeMs: number;
  runningSince: number | null;
  pauseReason: string | null;
  /** Number of commands applied (= sequence of the last command). */
  sequence: number;
  /** Effective time of the last command; later commands are clamped to it (monotonic). */
  lastAt: number;
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

export function assertTimerConfig(config: TimerConfig): void {
  if (!isInt(config.durationMs) || config.durationMs < TIMER_LIMITS.minDurationMs || config.durationMs > TIMER_LIMITS.maxDurationMs) {
    throw new DomainError("invalid_timer_duration");
  }
  if (!isInt(config.maxExtensionMs) || config.maxExtensionMs < 0 || config.maxExtensionMs > TIMER_LIMITS.maxTotalExtensionMs) {
    throw new DomainError("invalid_timer_max_extension");
  }
}

export function initialTimerState(config: TimerConfig): TimerState {
  assertTimerConfig(config);
  return {
    status: "idle", durationMs: config.durationMs, extendedMs: 0, maxExtensionMs: config.maxExtensionMs,
    elapsedBeforeMs: 0, runningSince: null, pauseReason: null, sequence: 0, lastAt: Number.NEGATIVE_INFINITY
  };
}

/** Validate command shape independent of state (used before touching storage). */
export function assertTimerCommandShape(command: Omit<TimerCommand, "at">): void {
  if (!(timerCommandTypes as readonly string[]).includes(command.type)) throw new DomainError("invalid_timer_command");
  if (command.type === "extend") {
    if (!isInt(command.amountMs) || command.amountMs < TIMER_LIMITS.minExtendMs || command.amountMs > TIMER_LIMITS.maxExtendStepMs) {
      throw new DomainError("invalid_timer_extension");
    }
  } else if (command.amountMs !== undefined && command.amountMs !== null) {
    throw new DomainError("invalid_timer_command");
  }
  if (command.type === "reset") {
    if (command.durationMs !== undefined && command.durationMs !== null &&
      (!isInt(command.durationMs) || command.durationMs < TIMER_LIMITS.minDurationMs || command.durationMs > TIMER_LIMITS.maxDurationMs)) {
      throw new DomainError("invalid_timer_duration");
    }
  } else if (command.durationMs !== undefined && command.durationMs !== null) {
    throw new DomainError("invalid_timer_command");
  }
  if (command.reason !== undefined && command.reason !== null &&
    (typeof command.reason !== "string" || command.reason.length > TIMER_LIMITS.maxReasonLength || /[\u0000-\u001f\u007f]/.test(command.reason))) {
    throw new DomainError("invalid_timer_reason");
  }
}

const elapsedAt = (state: TimerState, at: number) =>
  state.elapsedBeforeMs + (state.status === "running" && state.runningSince !== null ? at - state.runningSince : 0);

/** Apply one command. Throws DomainError("invalid_state_timer_<status>_<type>") on illegal transitions. */
export function applyTimerCommand(state: TimerState, command: TimerCommand): TimerState {
  assertTimerCommandShape(command);
  if (!Number.isFinite(command.at)) throw new DomainError("invalid_timer_command");
  if (state.sequence >= TIMER_LIMITS.maxCommands) throw new DomainError("timer_command_limit");
  const at = Math.max(command.at, state.lastAt);
  const base = { ...state, sequence: state.sequence + 1, lastAt: at };
  const illegal = () => new DomainError(`invalid_state_timer_${state.status}_${command.type}`);
  switch (command.type) {
    case "start":
      if (state.status !== "idle") throw illegal();
      return { ...base, status: "running", runningSince: at, pauseReason: null };
    case "pause":
      if (state.status !== "running") throw illegal();
      return { ...base, status: "paused", elapsedBeforeMs: elapsedAt(state, at), runningSince: null, pauseReason: command.reason ?? null };
    case "resume":
      if (state.status !== "paused") throw illegal();
      return { ...base, status: "running", runningSince: at, pauseReason: null };
    case "extend": {
      const extendedMs = state.extendedMs + command.amountMs!;
      if (extendedMs > state.maxExtensionMs) throw new DomainError("timer_extension_limit_exceeded");
      return { ...base, extendedMs };
    }
    case "reset":
      return {
        ...base, status: "idle", durationMs: command.durationMs ?? state.durationMs, extendedMs: 0,
        elapsedBeforeMs: 0, runningSince: null, pauseReason: null
      };
  }
}

/** Deterministic replay of an ordered log. Same log => same state, always. */
export function replayTimer(config: TimerConfig, commands: readonly TimerCommand[]): TimerState {
  return commands.reduce(applyTimerCommand, initialTimerState(config));
}

export interface TimerSnapshot {
  status: TimerStatus;
  phase: TimerPhase;
  durationMs: number;
  extendedMs: number;
  elapsedMs: number;
  /** Negative while in overtime. */
  remainingMs: number;
  overtimeMs: number;
  pauseReason: string | null;
  sequence: number;
  serverNow: number;
}

/** Project the state at server time `now` (never earlier than the last command). */
export function snapshotTimer(state: TimerState, now: number): TimerSnapshot {
  const at = Math.max(now, Number.isFinite(state.lastAt) ? state.lastAt : now);
  const elapsedMs = elapsedAt(state, at);
  const remainingMs = state.durationMs + state.extendedMs - elapsedMs;
  const overtimeMs = remainingMs < 0 ? -remainingMs : 0;
  const phase: TimerPhase = state.status === "running" && remainingMs <= 0 ? "overtime" : state.status;
  return {
    status: state.status, phase, durationMs: state.durationMs, extendedMs: state.extendedMs, elapsedMs,
    remainingMs, overtimeMs, pauseReason: state.pauseReason, sequence: state.sequence, serverNow: at
  };
}
