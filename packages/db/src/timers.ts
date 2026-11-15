import { DomainError, isBoundedText, isUuid } from "@live-competition-engine/domain";
import {
  applyTimerCommand,
  assertTimerCommandShape,
  assertTimerConfig,
  replayTimer,
  snapshotTimer,
  type TimerCommand,
  type TimerCommandType,
  type TimerSnapshot,
  type TimerState
} from "@live-competition-engine/domain/timer";
import { getSqlClient } from "./index.ts";
import { recordAudit, type Sql } from "./audit.ts";
import { assertCompetitionInTenant, bumpBroadcastSequence, isUniqueViolation, lockShowControl } from "./live-common.ts";
import { assertIdempotencyKey } from "./streams.ts";

export interface TimerView extends TimerSnapshot {
  timerId: string;
  competitionId: string;
  performanceId: string | null;
  label: string;
  /** ISO form of serverNow for clients that prefer strings. */
  serverNowIso: string;
}

interface TimerRow {
  id: string; competition_id: string; performance_id: string | null; label: string;
  duration_ms: number; max_extension_ms: number; head_sequence: number;
}

interface CommandRow {
  sequence: number; command: TimerCommandType; amount_ms: number | null; duration_ms: number | null;
  reason: string | null; issued_at_ms: string; actor_account_id: string; idempotency_key: string;
}

/** Injectable server clock; HTTP routes always use the real clock. */
export type Clock = () => number;
const systemClock: Clock = () => Date.now();

const toCommand = (row: CommandRow): TimerCommand => ({
  type: row.command, at: Number(row.issued_at_ms), amountMs: row.amount_ms, durationMs: row.duration_ms, reason: row.reason
});

async function loadTimer(sql: Sql, organizationId: string, timerId: string, lock: boolean): Promise<TimerRow> {
  if (!isUuid(timerId)) throw new DomainError("timer_not_found");
  const [row] = await sql<TimerRow[]>`
    SELECT id, competition_id, performance_id, label, duration_ms, max_extension_ms, head_sequence
    FROM stage_timers WHERE organization_id = ${organizationId} AND id = ${timerId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  if (!row) throw new DomainError("timer_not_found");
  return row;
}

async function loadState(sql: Sql, timer: TimerRow): Promise<TimerState> {
  const rows = await sql<CommandRow[]>`
    SELECT sequence, command, amount_ms, duration_ms, reason, issued_at_ms::text, actor_account_id, idempotency_key
    FROM stage_timer_commands WHERE timer_id = ${timer.id} ORDER BY sequence
  `;
  return replayTimer({ durationMs: timer.duration_ms, maxExtensionMs: timer.max_extension_ms }, rows.map(toCommand));
}

const toView = (timer: TimerRow, state: TimerState, now: number): TimerView => {
  const snapshot = snapshotTimer(state, now);
  return {
    timerId: timer.id, competitionId: timer.competition_id, performanceId: timer.performance_id, label: timer.label,
    ...snapshot, serverNowIso: new Date(snapshot.serverNow).toISOString()
  };
};

export async function createTimer(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: { performanceId?: string | null; label: unknown; durationMs: unknown; maxExtensionMs?: unknown }
): Promise<TimerView> {
  if (!isBoundedText(input.label, 80, 1) || (input.label as string).trim() !== input.label) throw new DomainError("invalid_timer_label");
  const config = { durationMs: input.durationMs as number, maxExtensionMs: (input.maxExtensionMs ?? 0) as number };
  assertTimerConfig(config);
  if (input.performanceId !== undefined && input.performanceId !== null && !isUuid(input.performanceId)) throw new DomainError("performance_not_found");
  try {
    return await getSqlClient().begin(async tx => {
      await assertCompetitionInTenant(tx, organizationId, competitionId);
      await lockShowControl(tx, organizationId, competitionId);
      if (input.performanceId) {
        const [performance] = await tx`SELECT 1 FROM performances WHERE organization_id = ${organizationId}
          AND competition_id = ${competitionId} AND id = ${input.performanceId}`;
        if (!performance) throw new DomainError("performance_not_found");
      }
      const [timer] = await tx<TimerRow[]>`
        INSERT INTO stage_timers (organization_id, competition_id, performance_id, label, duration_ms, max_extension_ms, created_by_account_id)
        VALUES (${organizationId}, ${competitionId}, ${input.performanceId ?? null}, ${input.label as string},
          ${config.durationMs}, ${config.maxExtensionMs}, ${actorAccountId})
        RETURNING id, competition_id, performance_id, label, duration_ms, max_extension_ms, head_sequence
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "timer.created", subjectType: "stage_timer", subjectId: timer!.id,
        details: { competitionId, performanceId: input.performanceId ?? null, durationMs: config.durationMs, maxExtensionMs: config.maxExtensionMs }
      });
      await bumpBroadcastSequence(tx, organizationId, competitionId);
      return toView(timer!, replayTimer(config, []), Date.now());
    });
  } catch (error) {
    if (isUniqueViolation(error, "stage_timers_one_per_performance")) throw new DomainError("timer_conflict_performance_has_timer");
    throw error;
  }
}

export interface TimerCommandInput {
  type: TimerCommandType;
  amountMs?: number | null;
  durationMs?: number | null;
  reason?: string | null;
  idempotencyKey: string;
  /** Optional optimistic guard: the client's last seen sequence. */
  expectedSequence?: number;
}

/**
 * Append a command inside an existing transaction. The timer row is locked
 * (FOR UPDATE) so concurrent producers are serialized; the command's time is the
 * server clock, clamped to be monotonic. The caller MUST already hold the
 * competition's show-control lock (`lockShowControl`), see lock ordering there.
 * Exposed for the control room safety stop.
 */
export async function appendTimerCommandTx(
  tx: Sql,
  organizationId: string,
  timerId: string,
  actorAccountId: string,
  input: TimerCommandInput,
  clock: Clock = systemClock
): Promise<{ view: TimerView; replayed: boolean }> {
  const timer = await loadTimer(tx, organizationId, timerId, true);
  const [existing] = await tx<CommandRow[]>`
    SELECT sequence, command, amount_ms, duration_ms, reason, issued_at_ms::text, actor_account_id, idempotency_key
    FROM stage_timer_commands WHERE timer_id = ${timerId} AND idempotency_key = ${input.idempotencyKey}
  `;
  const state = await loadState(tx, timer);
  if (existing) {
    if (existing.command !== input.type || existing.actor_account_id !== actorAccountId) throw new DomainError("idempotency_conflict");
    return { view: toView(timer, state, clock()), replayed: true };
  }
  if (input.expectedSequence !== undefined && input.expectedSequence !== state.sequence) {
    throw new DomainError("timer_sequence_conflict");
  }
  const at = clock();
  const next = applyTimerCommand(state, {
    type: input.type, at, amountMs: input.amountMs ?? null, durationMs: input.durationMs ?? null, reason: input.reason ?? null
  });
  await tx`
    INSERT INTO stage_timer_commands (organization_id, timer_id, sequence, command, amount_ms, duration_ms, reason,
      issued_at_ms, actor_account_id, idempotency_key)
    VALUES (${organizationId}, ${timerId}, ${next.sequence}, ${input.type}, ${input.amountMs ?? null}, ${input.durationMs ?? null},
      ${input.reason ?? null}, ${next.lastAt}, ${actorAccountId}, ${input.idempotencyKey})
  `;
  await tx`UPDATE stage_timers SET head_sequence = ${next.sequence}, updated_at = now() WHERE id = ${timerId}`;
  await bumpBroadcastSequence(tx, organizationId, timer.competition_id);
  await recordAudit(tx, {
    organizationId, actorAccountId, action: `timer.${input.type}`, subjectType: "stage_timer", subjectId: timerId,
    details: {
      sequence: next.sequence, at: next.lastAt,
      ...(input.amountMs ? { amountMs: input.amountMs } : {}),
      ...(input.durationMs ? { durationMs: input.durationMs } : {}),
      ...(input.reason ? { reason: input.reason } : {})
    }
  });
  return { view: toView(timer, next, at), replayed: false };
}

export async function issueTimerCommand(
  organizationId: string,
  timerId: string,
  actorAccountId: string,
  input: TimerCommandInput,
  clock: Clock = systemClock
): Promise<{ view: TimerView; replayed: boolean }> {
  assertIdempotencyKey(input.idempotencyKey);
  assertTimerCommandShape(input);
  if (input.expectedSequence !== undefined && (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0)) {
    throw new DomainError("invalid_expected_sequence");
  }
  return getSqlClient().begin(async tx => {
    const timer = await loadTimer(tx, organizationId, timerId, false);
    await lockShowControl(tx, organizationId, timer.competition_id);
    return appendTimerCommandTx(tx, organizationId, timerId, actorAccountId, input, clock);
  });
}

export async function getTimer(organizationId: string, timerId: string, clock: Clock = systemClock): Promise<TimerView> {
  const sql = getSqlClient();
  const timer = await loadTimer(sql, organizationId, timerId, false);
  return toView(timer, await loadState(sql, timer), clock());
}

export async function listTimers(organizationId: string, competitionId: string, clock: Clock = systemClock): Promise<TimerView[]> {
  const sql = getSqlClient();
  const timers = await sql<TimerRow[]>`
    SELECT id, competition_id, performance_id, label, duration_ms, max_extension_ms, head_sequence
    FROM stage_timers WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    ORDER BY created_at LIMIT 200
  `;
  const now = clock();
  return Promise.all(timers.map(async timer => toView(timer, await loadState(sql, timer), now)));
}

/** The append-only log, for review and deterministic re-derivation. */
export async function getTimerLog(organizationId: string, timerId: string) {
  const sql = getSqlClient();
  const timer = await loadTimer(sql, organizationId, timerId, false);
  const rows = await sql<CommandRow[]>`
    SELECT sequence, command, amount_ms, duration_ms, reason, issued_at_ms::text, actor_account_id, idempotency_key
    FROM stage_timer_commands WHERE timer_id = ${timer.id} ORDER BY sequence
  `;
  return rows.map(row => ({
    sequence: row.sequence, type: row.command, amountMs: row.amount_ms, durationMs: row.duration_ms, reason: row.reason,
    at: Number(row.issued_at_ms), actorAccountId: row.actor_account_id
  }));
}

/** Timers in a competition whose replayed state is running (used by the safety stop). */
export async function runningTimerIds(tx: Sql, organizationId: string, competitionId: string): Promise<string[]> {
  const timers = await tx<TimerRow[]>`
    SELECT id, competition_id, performance_id, label, duration_ms, max_extension_ms, head_sequence
    FROM stage_timers WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    ORDER BY id
  `;
  const running: string[] = [];
  for (const timer of timers) if ((await loadState(tx, timer)).status === "running") running.push(timer.id);
  return running;
}
