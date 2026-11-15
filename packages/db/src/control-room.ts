import {
  applyTimerCommand, DomainError, parseContestConfig, parseTimerCommand, replayTimer, viewTimer,
  type TimerCommand, type TimerEvent, type TimerLimits, type TimerView
} from "@live-competition-engine/engine";
import type { TransactionSql } from "postgres";
import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";
import { lockEvent, type EventRecord } from "./events.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Executor = TransactionSql | ReturnType<typeof getSqlClient>;

function limitsFor(event: Pick<EventRecord, "config">): TimerLimits {
  const config = parseContestConfig(event.config);
  return { maxExtensionMs: config.timing.maxExtensionSeconds * 1000, graceMs: config.timing.overtimeGraceSeconds * 1000 };
}

export function timerKey(kind: "stage" | "performance", id: string) {
  if (!uuid.test(id)) throw new DomainError(400, "invalid_timer_key");
  return `${kind}:${id.toLowerCase()}`;
}

async function loadTimer(tx: Executor, eventId: string, key: string) {
  const rows = await tx<{ seq: number; at: Date; command: TimerCommand }[]>`
    SELECT seq, at, command FROM timer_events WHERE competition_id = ${eventId} AND timer_key = ${key} ORDER BY seq`;
  return rows.map(r => ({ seq: r.seq, at: r.at.getTime(), command: r.command }) as TimerEvent);
}

async function dbNow(tx: Executor): Promise<number> {
  const [row] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row!.now.getTime();
}

/** Appends a timer command at server time. `expectedSeq` gives optimistic concurrency between producers. */
export async function timerCommandTx(tx: TransactionSql, organizationId: string, event: EventRecord, key: string, actorAccountId: string, commandInput: unknown, expectedSeq?: unknown): Promise<TimerView> {
  const command = parseTimerCommand(commandInput);
  const limits = limitsFor(event);
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`timer:${event.id}:${key}`}))`;
  const events = await loadTimer(tx, event.id, key);
  const state = replayTimer(events, limits);
  if (expectedSeq !== undefined && expectedSeq !== state.seq) throw new DomainError(409, "timer_sequence_conflict");
  const now = await dbNow(tx);
  const next = applyTimerCommand(state, { seq: state.seq + 1, at: now, command }, limits);
  await tx`INSERT INTO timer_events (organization_id, competition_id, timer_key, seq, command, at, actor_account_id)
    VALUES (${organizationId}, ${event.id}, ${key}, ${next.seq}, ${tx.json(command as never)}, ${new Date(now)}, ${actorAccountId})`;
  await recordAudit(tx, { organizationId, actorAccountId, action: `timer.${command.type}`, subjectType: "timer", subjectId: key, details: { seq: next.seq } });
  return viewTimer(next, now, limits);
}

export async function timerCommand(organizationId: string, eventId: string, key: string, actorAccountId: string, command: unknown, expectedSeq?: unknown) {
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status !== "live" && event.status !== "paused") throw new DomainError(409, "event_not_live");
    return timerCommandTx(tx, organizationId, event, key, actorAccountId, command, expectedSeq);
  });
}

export async function readTimer(organizationId: string, event: EventRecord, key: string): Promise<TimerView> {
  const sql = getSqlClient();
  const events = await loadTimer(sql, event.id, key);
  return viewTimer(replayTimer(events, limitsFor(event)), await dbNow(sql), limitsFor(event));
}

/* ---------- LC-25 control room ---------- */

async function lockPerformance(tx: TransactionSql, organizationId: string, eventId: string, performanceId: unknown) {
  if (typeof performanceId !== "string" || !uuid.test(performanceId)) throw new DomainError(400, "invalid_performance_id");
  const [p] = await tx<{ id: string; round_id: string; status: string; stage_status: string; timed: boolean; duration_seconds: number | null }[]>`
    SELECT pf.id, pf.round_id, pf.status::text AS status, r.status::text AS stage_status, r.timed, r.duration_seconds
    FROM performances pf JOIN rounds r ON r.id = pf.round_id
    WHERE pf.organization_id = ${organizationId} AND pf.competition_id = ${eventId} AND pf.id = ${performanceId} FOR UPDATE OF pf`;
  if (!p) throw new DomainError(404, "performance_not_found");
  return p;
}

/** Puts a queued performance on stage; timed stages start the performance clock in the same transaction. */
export async function startPerformance(organizationId: string, eventId: string, actorAccountId: string, performanceId: unknown) {
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status !== "live") throw new DomainError(409, "event_not_live");
    const p = await lockPerformance(tx, organizationId, eventId, performanceId);
    if (p.stage_status !== "live") throw new DomainError(409, "stage_not_live");
    if (p.status !== "queued") throw new DomainError(409, "performance_not_queued");
    const [other] = await tx`SELECT 1 FROM performances WHERE round_id = ${p.round_id} AND status = 'live'`;
    if (other) throw new DomainError(409, "another_performance_live");
    await tx`UPDATE performances SET status = 'live', started_at = now() WHERE id = ${p.id}`;
    const config = parseContestConfig(event.config);
    const seconds = p.timed && p.duration_seconds ? p.duration_seconds : config.timing.performanceSeconds;
    const timer = seconds > 0 ? await timerCommandTx(tx, organizationId, event, timerKey("performance", p.id), actorAccountId, { type: "start", durationMs: seconds * 1000 }) : null;
    await tx`UPDATE performer_readiness SET status = 'on_stage', updated_at = now(), updated_by_account_id = ${actorAccountId}
      WHERE competition_id = ${eventId} AND entry_id = (SELECT entry_id FROM performances WHERE id = ${p.id})`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "performance.started", subjectType: "performance", subjectId: p.id });
    return { performanceId: p.id, status: "live", timer };
  });
}

export async function finishPerformance(organizationId: string, eventId: string, actorAccountId: string, performanceId: unknown, outcome: "completed" | "skipped", reason?: unknown) {
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    const p = await lockPerformance(tx, organizationId, eventId, performanceId);
    if (outcome === "completed" && p.status !== "live") throw new DomainError(409, "performance_not_live");
    if (outcome === "skipped") {
      if (p.status !== "queued") throw new DomainError(409, "performance_not_queued");
      if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "reason_required");
    }
    await tx`UPDATE performances SET status = ${outcome}, completed_at = now() WHERE id = ${p.id}`;
    if (outcome === "completed") {
      const key = timerKey("performance", p.id);
      const state = replayTimer(await loadTimer(tx, eventId, key), limitsFor(event));
      if (state.status === "running" || state.status === "paused") await timerCommandTx(tx, organizationId, event, key, actorAccountId, { type: "stop" });
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: `performance.${outcome}`, subjectType: "performance", subjectId: p.id, details: typeof reason === "string" ? { reason } : {} });
    return { performanceId: p.id, status: outcome };
  });
}

/** Safety stop: pauses the event and every running clock, records the reason and cues all backstage. */
export async function safetyStop(organizationId: string, eventId: string, actorAccountId: string, reason: unknown) {
  if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "reason_required");
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status !== "live") throw new DomainError(409, "event_not_live");
    await tx`UPDATE competitions SET status = 'paused', revision = revision + 1, updated_at = now() WHERE id = ${eventId}`;
    const keys = await tx<{ timer_key: string }[]>`SELECT DISTINCT timer_key FROM timer_events WHERE competition_id = ${eventId}`;
    let paused = 0;
    for (const { timer_key } of keys) {
      const state = replayTimer(await loadTimer(tx, eventId, timer_key), limitsFor(event));
      if (state.status === "running") {
        await timerCommandTx(tx, organizationId, event, timer_key, actorAccountId, { type: "pause" });
        paused += 1;
      }
    }
    await upsertLiveState(tx, organizationId, eventId, actorAccountId, { safetyStopReason: reason.trim(), overlayMessage: "Please stand by" });
    await tx`INSERT INTO backstage_messages (organization_id, competition_id, author_account_id, author_role, audience, kind, body)
      VALUES (${organizationId}, ${eventId}, ${actorAccountId}, 'producer', 'everyone_backstage', 'cue', ${`SAFETY STOP: ${reason.trim()}`})`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "control.safety_stop", subjectType: "event", subjectId: eventId, details: { reason, pausedTimers: paused } });
    return { status: "paused", pausedTimers: paused };
  });
}

/* ---------- LC-26 live presentation state ---------- */

export interface LiveState { caption: string | null; overlayMessage: string | null; showScoreboard: boolean; safetyStopReason: string | null; revision: number; updatedAt: Date | null }

async function upsertLiveState(tx: Executor, organizationId: string, eventId: string, actorAccountId: string, change: Partial<Pick<LiveState, "caption" | "overlayMessage" | "showScoreboard" | "safetyStopReason">>) {
  const [row] = await tx<{ caption: string | null; overlay_message: string | null; show_scoreboard: boolean; safety_stop_reason: string | null; revision: number; updated_at: Date }[]>`
    INSERT INTO event_live_state (organization_id, competition_id, caption, overlay_message, show_scoreboard, safety_stop_reason, updated_by_account_id)
    VALUES (${organizationId}, ${eventId}, ${change.caption ?? null}, ${change.overlayMessage ?? null}, ${change.showScoreboard ?? false}, ${change.safetyStopReason ?? null}, ${actorAccountId})
    ON CONFLICT (competition_id) DO UPDATE SET
      caption = CASE WHEN ${change.caption !== undefined} THEN EXCLUDED.caption ELSE event_live_state.caption END,
      overlay_message = CASE WHEN ${change.overlayMessage !== undefined} THEN EXCLUDED.overlay_message ELSE event_live_state.overlay_message END,
      show_scoreboard = CASE WHEN ${change.showScoreboard !== undefined} THEN EXCLUDED.show_scoreboard ELSE event_live_state.show_scoreboard END,
      safety_stop_reason = CASE WHEN ${change.safetyStopReason !== undefined} THEN EXCLUDED.safety_stop_reason ELSE event_live_state.safety_stop_reason END,
      revision = event_live_state.revision + 1, updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
    RETURNING caption, overlay_message, show_scoreboard, safety_stop_reason, revision, updated_at`;
  return { caption: row!.caption, overlayMessage: row!.overlay_message, showScoreboard: row!.show_scoreboard, safetyStopReason: row!.safety_stop_reason, revision: row!.revision, updatedAt: row!.updated_at };
}

export async function updateLiveState(organizationId: string, eventId: string, actorAccountId: string, input: { caption?: unknown; overlayMessage?: unknown; showScoreboard?: unknown; clearSafetyStop?: unknown }) {
  const text = (v: unknown, max: number) => v === undefined ? undefined : v === null || v === "" ? null : typeof v === "string" && v.length <= max ? v.trim() : (() => { throw new DomainError(400, "invalid_live_state"); })();
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const state = await upsertLiveState(tx, organizationId, eventId, actorAccountId, {
      caption: text(input.caption, 500), overlayMessage: text(input.overlayMessage, 200),
      showScoreboard: typeof input.showScoreboard === "boolean" ? input.showScoreboard : undefined,
      safetyStopReason: input.clearSafetyStop === true ? null : undefined
    });
    await recordAudit(tx, { organizationId, actorAccountId, action: "control.live_state", subjectType: "event", subjectId: eventId, details: { revision: state.revision } });
    return state;
  });
}

export async function getLiveState(organizationId: string, eventId: string): Promise<LiveState> {
  const [row] = await getSqlClient()<{ caption: string | null; overlay_message: string | null; show_scoreboard: boolean; safety_stop_reason: string | null; revision: number; updated_at: Date }[]>`
    SELECT caption, overlay_message, show_scoreboard, safety_stop_reason, revision, updated_at FROM event_live_state WHERE organization_id = ${organizationId} AND competition_id = ${eventId}`;
  return row ? { caption: row.caption, overlayMessage: row.overlay_message, showScoreboard: row.show_scoreboard, safetyStopReason: row.safety_stop_reason, revision: row.revision, updatedAt: row.updated_at }
    : { caption: null, overlayMessage: null, showScoreboard: false, safetyStopReason: null, revision: 0, updatedAt: null };
}

export interface LiveSnapshot {
  serverNow: number;
  event: { id: string; title: string; status: string };
  stage: { id: string; label: string; ordinal: number } | null;
  current: { performanceId: string; displayName: string; ordinal: number; timer: TimerView | null } | null;
  next: { displayName: string; ordinal: number } | null;
  live: LiveState;
}

/** One read for overlays and reconnecting producers: everything derives from server state. */
export async function liveSnapshot(organizationId: string, event: EventRecord): Promise<LiveSnapshot> {
  const sql = getSqlClient();
  const config = parseContestConfig(event.config);
  const [stage] = await sql<{ id: string; label: string; ordinal: number }[]>`
    SELECT id, label, ordinal FROM rounds WHERE organization_id = ${organizationId} AND competition_id = ${event.id} AND status = 'live' LIMIT 1`;
  let current: LiveSnapshot["current"] = null, next: LiveSnapshot["next"] = null;
  if (stage) {
    const slots = await sql<{ id: string; ordinal: number; status: string; display_name: string }[]>`
      SELECT pf.id, pf.ordinal, pf.status::text AS status, p.display_name FROM performances pf
      JOIN entries e ON e.id = pf.entry_id JOIN participants p ON p.id = e.participant_id
      WHERE pf.round_id = ${stage.id} ORDER BY pf.ordinal`;
    const live = slots.find(s => s.status === "live");
    const name = (s: { display_name: string; ordinal: number }) => config.judging.blind ? `${config.labels.performance} #${s.ordinal}` : s.display_name;
    if (live) current = { performanceId: live.id, displayName: name(live), ordinal: live.ordinal, timer: await readTimer(organizationId, event, timerKey("performance", live.id)) };
    const upcoming = slots.find(s => s.status === "queued");
    if (upcoming) next = { displayName: name(upcoming), ordinal: upcoming.ordinal };
  }
  return { serverNow: await dbNow(sql), event: { id: event.id, title: event.title, status: event.status }, stage: stage ?? null, current, next, live: await getLiveState(organizationId, event.id) };
}
