import { DomainError } from "./errors.ts";

/**
 * LC-24 server-authoritative timer. State is a pure function of an append-only command log whose
 * timestamps come from the server clock, so every client (and a reconnecting producer) derives
 * the same remaining time.
 */
export type TimerCommand =
  | { type: "start"; durationMs: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "extend"; ms: number }
  | { type: "reset"; durationMs?: number }
  | { type: "stop" };

export interface TimerEvent { seq: number; at: number; command: TimerCommand }

export interface TimerState {
  status: "idle" | "running" | "paused" | "stopped";
  durationMs: number;
  extendedMs: number;
  accumulatedMs: number;
  runningSince: number | null;
  seq: number;
}

export interface TimerView extends TimerState {
  elapsedMs: number;
  remainingMs: number;
  overtimeMs: number;
  /** In overtime but within the configured grace period. */
  inGrace: boolean;
  serverNow: number;
}

export interface TimerLimits { maxExtensionMs: number; graceMs: number; maxDurationMs?: number }

export const initialTimer = (): TimerState => ({ status: "idle", durationMs: 0, extendedMs: 0, accumulatedMs: 0, runningSince: null, seq: 0 });

export function parseTimerCommand(input: unknown): TimerCommand {
  if (!input || typeof input !== "object") throw new DomainError(400, "invalid_timer_command");
  const c = input as Record<string, unknown>;
  const ms = (v: unknown, max: number) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > max) throw new DomainError(400, "invalid_timer_duration");
    return v;
  };
  switch (c.type) {
    case "start": return { type: "start", durationMs: ms(c.durationMs, 24 * 3600_000) };
    case "extend": return { type: "extend", ms: ms(c.ms, 3600_000) };
    case "reset": return c.durationMs === undefined ? { type: "reset" } : { type: "reset", durationMs: ms(c.durationMs, 24 * 3600_000) };
    case "pause": case "resume": case "stop": return { type: c.type };
    default: throw new DomainError(400, "invalid_timer_command");
  }
}

export function applyTimerCommand(state: TimerState, event: TimerEvent, limits: TimerLimits): TimerState {
  if (event.seq !== state.seq + 1) throw new DomainError(409, "timer_sequence_conflict");
  const c = event.command;
  const elapsedNow = state.accumulatedMs + (state.runningSince === null ? 0 : event.at - state.runningSince);
  const base = { ...state, seq: event.seq };
  switch (c.type) {
    case "start":
      if (state.status === "running" || state.status === "paused") throw new DomainError(409, "timer_already_started");
      if (limits.maxDurationMs && c.durationMs > limits.maxDurationMs) throw new DomainError(400, "timer_duration_exceeds_stage");
      return { ...base, status: "running", durationMs: c.durationMs, extendedMs: 0, accumulatedMs: 0, runningSince: event.at };
    case "pause":
      if (state.status !== "running") throw new DomainError(409, "timer_not_running");
      return { ...base, status: "paused", accumulatedMs: elapsedNow, runningSince: null };
    case "resume":
      if (state.status !== "paused") throw new DomainError(409, "timer_not_paused");
      return { ...base, status: "running", runningSince: event.at };
    case "extend":
      if (state.status !== "running" && state.status !== "paused") throw new DomainError(409, "timer_not_active");
      if (state.extendedMs + c.ms > limits.maxExtensionMs) throw new DomainError(409, "extension_limit_reached");
      return { ...base, extendedMs: state.extendedMs + c.ms };
    case "reset":
      return { ...base, status: "idle", durationMs: c.durationMs ?? state.durationMs, extendedMs: 0, accumulatedMs: 0, runningSince: null };
    case "stop":
      if (state.status !== "running" && state.status !== "paused") throw new DomainError(409, "timer_not_active");
      return { ...base, status: "stopped", accumulatedMs: elapsedNow, runningSince: null };
  }
}

export function replayTimer(events: TimerEvent[], limits: TimerLimits): TimerState {
  return [...events].sort((a, b) => a.seq - b.seq).reduce((s, e) => applyTimerCommand(s, e, limits), initialTimer());
}

export function viewTimer(state: TimerState, now: number, limits: TimerLimits): TimerView {
  const elapsedMs = state.accumulatedMs + (state.runningSince === null ? 0 : Math.max(0, now - state.runningSince));
  const remaining = state.durationMs + state.extendedMs - elapsedMs;
  const overtimeMs = state.status === "idle" ? 0 : Math.max(0, -remaining);
  return { ...state, elapsedMs, remainingMs: Math.max(0, remaining), overtimeMs, inGrace: overtimeMs > 0 && overtimeMs <= limits.graceMs, serverNow: now };
}
