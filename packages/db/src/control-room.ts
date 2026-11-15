import { DomainError, isBoundedText, isUuid } from "@live-competition-engine/domain";
import {
  assertPerformanceTransition,
  assertRoundTransition,
  assertShowTransition,
  normalizeReason,
  nowAndNext,
  planReorder,
  type LineupRound,
  type PerformanceStatus,
  type RoundStatus,
  type ShowState
} from "@live-competition-engine/domain/control-room";
import { getSqlClient } from "./index.ts";
import { recordAudit, type Sql } from "./audit.ts";
import { assertCompetitionInTenant, bumpBroadcastSequence, lockShowControl, type ShowControlRow } from "./live-common.ts";
import { appendTimerCommandTx, runningTimerIds } from "./timers.ts";

/* ------------------------------------------------------------------ */
/* Judge status: pluggable so a scoring module can supply real data.    */
/* ------------------------------------------------------------------ */

export interface JudgeStatus {
  judgeId: string;
  displayName: string;
  /** null when the source cannot tell. */
  submitted: boolean | null;
}

export interface JudgeStatusReport {
  performanceId: string;
  source: string;
  /** "unknown" means no scoring source is wired; never treat it as "all submitted". */
  status: "known" | "unknown";
  judges: JudgeStatus[];
}

export interface JudgeStatusSource {
  forPerformance(organizationId: string, competitionId: string, performanceId: string): Promise<JudgeStatusReport>;
}

/**
 * Default source: lists the competition's judges with `submitted: null`. A scoring
 * module (built separately) should provide its own JudgeStatusSource.
 */
export const unknownJudgeStatusSource: JudgeStatusSource = {
  async forPerformance(organizationId, competitionId, performanceId) {
    const judges = await getSqlClient()<{ id: string; display_name: string }[]>`
      SELECT j.id, j.display_name FROM competition_judges cj
      JOIN judges j ON j.id = cj.judge_id AND j.organization_id = cj.organization_id
      WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${competitionId}
      ORDER BY j.display_name, j.id
    `;
    return {
      performanceId, source: "none", status: "unknown",
      judges: judges.map(judge => ({ judgeId: judge.id, displayName: judge.display_name, submitted: null }))
    };
  }
};

/* ------------------------------------------------------------------ */
/* Lineup loading                                                      */
/* ------------------------------------------------------------------ */

interface ProducerPerformance { id: string; ordinal: number; status: PerformanceStatus; entryId: string; displayName: string; startedAt: string | null; completedAt: string | null }
interface ProducerRound { id: string; label: string; ordinal: number; status: RoundStatus; resultsPublished: boolean; publicationRevision: number; performances: ProducerPerformance[] }

async function loadLineup(sql: Sql, organizationId: string, competitionId: string, lock = false): Promise<ProducerRound[]> {
  if (lock) {
    // Show lock is already held; additionally lock rows we may update.
    await sql`SELECT id FROM rounds WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} FOR UPDATE`;
  }
  const rows = await sql<{
    round_id: string; label: string; round_ordinal: number; round_status: RoundStatus; published: boolean | null; pub_revision: number | null;
    performance_id: string | null; ordinal: number | null; status: PerformanceStatus | null; entry_id: string | null;
    display_name: string | null; started_at: Date | null; completed_at: Date | null;
  }[]>`
    SELECT r.id AS round_id, r.label, r.ordinal AS round_ordinal, r.status::text AS round_status,
      rp.results_published AS published, rp.revision AS pub_revision,
      p.id AS performance_id, p.ordinal, p.status::text AS status, p.entry_id, pt.display_name, p.started_at, p.completed_at
    FROM rounds r
    LEFT JOIN round_publications rp ON rp.organization_id = r.organization_id AND rp.round_id = r.id
    LEFT JOIN performances p ON p.round_id = r.id AND p.organization_id = r.organization_id
    LEFT JOIN entries e ON e.id = p.entry_id AND e.organization_id = p.organization_id
    LEFT JOIN participants pt ON pt.id = e.participant_id AND pt.organization_id = e.organization_id
    WHERE r.organization_id = ${organizationId} AND r.competition_id = ${competitionId}
    ORDER BY r.ordinal, p.ordinal
  `;
  const rounds = new Map<string, ProducerRound>();
  for (const row of rows) {
    let round = rounds.get(row.round_id);
    if (!round) {
      round = {
        id: row.round_id, label: row.label, ordinal: row.round_ordinal, status: row.round_status,
        resultsPublished: row.published ?? false, publicationRevision: row.pub_revision ?? 0, performances: []
      };
      rounds.set(row.round_id, round);
    }
    if (row.performance_id && row.status && row.ordinal !== null && row.entry_id) {
      round.performances.push({
        id: row.performance_id, ordinal: row.ordinal, status: row.status, entryId: row.entry_id, displayName: row.display_name ?? "",
        startedAt: row.started_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null
      });
    }
  }
  return [...rounds.values()];
}

const asLineup = (rounds: ProducerRound[]): LineupRound[] => rounds;

/* ------------------------------------------------------------------ */
/* Read model                                                          */
/* ------------------------------------------------------------------ */

export interface ControlRoomView {
  show: { state: ShowState; pauseReason: string | null; revision: number; broadcastSequence: number; updatedAt: string };
  rounds: ProducerRound[];
  now: ProducerPerformance | null;
  next: ProducerPerformance | null;
  judgeStatus: JudgeStatusReport | null;
  entries: Array<{ entryId: string; displayName: string }>;
  serverNow: string;
}

const showView = (row: ShowControlRow) => ({
  state: row.state, pauseReason: row.pause_reason, revision: row.revision,
  broadcastSequence: Number(row.broadcast_sequence), updatedAt: row.updated_at.toISOString()
});

export async function getControlRoom(
  organizationId: string,
  competitionId: string,
  judgeSource: JudgeStatusSource = unknownJudgeStatusSource
): Promise<ControlRoomView> {
  const sql = getSqlClient();
  await assertCompetitionInTenant(sql, organizationId, competitionId);
  const [show] = await sql<ShowControlRow[]>`
    SELECT state, pause_reason, current_performance_id, revision, broadcast_sequence::text, updated_at
    FROM show_controls WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
  `;
  const rounds = await loadLineup(sql, organizationId, competitionId);
  const pointers = nowAndNext(asLineup(rounds));
  const all = rounds.flatMap(round => round.performances);
  const entries = await sql<{ id: string; display_name: string }[]>`
    SELECT e.id, pt.display_name FROM entries e
    JOIN participants pt ON pt.id = e.participant_id AND pt.organization_id = e.organization_id
    WHERE e.organization_id = ${organizationId} AND e.competition_id = ${competitionId} AND e.status = 'approved'
    ORDER BY pt.display_name, e.id LIMIT 500
  `;
  return {
    show: show ? showView(show) : { state: "standby", pauseReason: null, revision: 0, broadcastSequence: 0, updatedAt: new Date(0).toISOString() },
    rounds,
    now: all.find(p => p.id === pointers.now) ?? null,
    next: all.find(p => p.id === pointers.next) ?? null,
    judgeStatus: pointers.now ? await judgeSource.forPerformance(organizationId, competitionId, pointers.now) : null,
    entries: entries.map(entry => ({ entryId: entry.id, displayName: entry.display_name })),
    serverNow: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ */
/* Mutations: each locks the show row first (serializes per competition) */
/* ------------------------------------------------------------------ */

async function mutate<T>(
  organizationId: string,
  competitionId: string,
  expectedRevision: number | undefined,
  fn: (tx: Sql, show: ShowControlRow) => Promise<T>
): Promise<T> {
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new DomainError("invalid_expected_revision");
  }
  return (await getSqlClient().begin(async tx => {
    await assertCompetitionInTenant(tx, organizationId, competitionId);
    const show = await lockShowControl(tx, organizationId, competitionId);
    if (expectedRevision !== undefined && expectedRevision !== show.revision) throw new DomainError("show_revision_conflict");
    const result = await fn(tx, show);
    await tx`UPDATE show_controls SET revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
    await bumpBroadcastSequence(tx, organizationId, competitionId);
    return result;
  })) as T;
}

async function setShowState(tx: Sql, organizationId: string, competitionId: string, actor: string, state: ShowState, reason: string | null) {
  await tx`UPDATE show_controls SET state = ${state}, pause_reason = ${reason}, updated_by_account_id = ${actor}
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
}

export type ShowCommand = "start" | "resume" | "end";

/** Start, resume (after a safety stop) or end the show. */
export async function changeShowState(
  organizationId: string, competitionId: string, actor: string, command: ShowCommand, expectedRevision?: number
): Promise<{ state: ShowState }> {
  const target: Record<ShowCommand, ShowState> = { start: "running", resume: "running", end: "ended" };
  if (!(command in target)) throw new DomainError("invalid_show_command");
  return mutate(organizationId, competitionId, expectedRevision, async (tx, show) => {
    if (command === "start" && show.state !== "standby") throw new DomainError(`invalid_state_show_${show.state}_start`);
    if (command === "resume" && show.state !== "paused") throw new DomainError(`invalid_state_show_${show.state}_resume`);
    const to = target[command];
    assertShowTransition(show.state, to);
    await setShowState(tx, organizationId, competitionId, actor, to, null);
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: `show.${command}`, subjectType: "competition", subjectId: competitionId,
      details: { from: show.state, to }
    });
    return { state: to };
  });
}

/**
 * Safety stop: pauses the show with a reason and pauses every running timer of the
 * competition in the same transaction, so nothing keeps counting while stopped.
 */
export async function safetyStop(
  organizationId: string, competitionId: string, actor: string, reasonInput: unknown
): Promise<{ state: ShowState; pausedTimerIds: string[] }> {
  const reason = normalizeReason(reasonInput);
  return mutate(organizationId, competitionId, undefined, async (tx, show) => {
    if (show.state !== "running") throw new DomainError(`invalid_state_show_${show.state}_safety_stop`);
    assertShowTransition(show.state, "paused");
    await setShowState(tx, organizationId, competitionId, actor, "paused", reason);
    const timers = await runningTimerIds(tx, organizationId, competitionId);
    for (const timerId of timers) {
      await appendTimerCommandTx(tx, organizationId, timerId, actor, {
        type: "pause", reason: `safety_stop: ${reason}`.slice(0, 200),
        idempotencyKey: `safety-stop-${show.revision}-${timerId}`
      });
    }
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: "show.safety_stop", subjectType: "competition", subjectId: competitionId,
      details: { reason, pausedTimerIds: timers }
    });
    return { state: "paused" as const, pausedTimerIds: timers };
  });
}

export async function createRound(
  organizationId: string, competitionId: string, actor: string, input: { label: unknown }
): Promise<{ roundId: string; ordinal: number }> {
  if (!isBoundedText(input.label, 80, 1) || (input.label as string).trim() !== input.label) throw new DomainError("invalid_round_label");
  return mutate(organizationId, competitionId, undefined, async tx => {
    const [next] = await tx<{ ordinal: number }[]>`SELECT COALESCE(max(ordinal), 0) + 1 AS ordinal FROM rounds
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
    if (next!.ordinal > 100) throw new DomainError("round_limit_exceeded");
    const [round] = await tx<{ id: string }[]>`INSERT INTO rounds (organization_id, competition_id, label, ordinal)
      VALUES (${organizationId}, ${competitionId}, ${input.label as string}, ${next!.ordinal}) RETURNING id`;
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: "lineup.round_created", subjectType: "round", subjectId: round!.id,
      details: { competitionId, ordinal: next!.ordinal }
    });
    return { roundId: round!.id, ordinal: next!.ordinal };
  });
}

export async function addPerformance(
  organizationId: string, competitionId: string, actor: string, input: { roundId: unknown; entryId: unknown }
): Promise<{ performanceId: string; ordinal: number }> {
  if (!isUuid(input.roundId)) throw new DomainError("round_not_found");
  if (!isUuid(input.entryId)) throw new DomainError("entry_not_found");
  return mutate(organizationId, competitionId, undefined, async tx => {
    const [round] = await tx<{ status: RoundStatus }[]>`SELECT status::text AS status FROM rounds
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${input.roundId as string} FOR UPDATE`;
    if (!round) throw new DomainError("round_not_found");
    if (round.status === "completed" || round.status === "cancelled") throw new DomainError(`invalid_state_round_${round.status}`);
    const [entry] = await tx<{ status: string }[]>`SELECT status::text AS status FROM entries
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${input.entryId as string}`;
    if (!entry) throw new DomainError("entry_not_found");
    if (entry.status !== "approved") throw new DomainError("invalid_state_entry_not_approved");
    const [next] = await tx<{ ordinal: number }[]>`SELECT COALESCE(max(ordinal), 0) + 1 AS ordinal FROM performances
      WHERE round_id = ${input.roundId as string}`;
    if (next!.ordinal > 500) throw new DomainError("performance_limit_exceeded");
    const [performance] = await tx<{ id: string }[]>`
      INSERT INTO performances (organization_id, competition_id, round_id, entry_id, ordinal)
      VALUES (${organizationId}, ${competitionId}, ${input.roundId as string}, ${input.entryId as string}, ${next!.ordinal}) RETURNING id`;
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: "lineup.performance_added", subjectType: "performance", subjectId: performance!.id,
      details: { roundId: input.roundId, entryId: input.entryId, ordinal: next!.ordinal }
    });
    return { performanceId: performance!.id, ordinal: next!.ordinal };
  });
}

export async function reorderRound(
  organizationId: string, competitionId: string, actor: string, roundId: string, performanceIds: unknown, expectedRevision?: number
): Promise<{ order: Array<{ id: string; ordinal: number }> }> {
  if (!Array.isArray(performanceIds) || performanceIds.length > 500 || !performanceIds.every(isUuid)) throw new DomainError("invalid_lineup_order");
  return mutate(organizationId, competitionId, expectedRevision, async tx => {
    const rounds = await loadLineup(tx, organizationId, competitionId, true);
    const round = rounds.find(candidate => candidate.id === roundId);
    if (!round) throw new DomainError("round_not_found");
    if (round.status === "completed" || round.status === "cancelled") throw new DomainError(`invalid_state_round_${round.status}`);
    const order = planReorder(round.performances, performanceIds as string[]);
    // Two phases avoid transient (round_id, ordinal) unique violations.
    await tx`UPDATE performances SET ordinal = ordinal + 100000 WHERE round_id = ${roundId} AND organization_id = ${organizationId}`;
    for (const item of order) {
      await tx`UPDATE performances SET ordinal = ${item.ordinal} WHERE id = ${item.id} AND organization_id = ${organizationId}`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: "lineup.reordered", subjectType: "round", subjectId: roundId,
      details: { order: order.map(item => item.id) }
    });
    return { order };
  });
}

export async function transitionRound(
  organizationId: string, competitionId: string, actor: string, roundId: string, to: unknown, expectedRevision?: number
): Promise<{ roundId: string; status: RoundStatus }> {
  if (!["live", "completed", "cancelled"].includes(to as string)) throw new DomainError("invalid_round_status");
  return mutate(organizationId, competitionId, expectedRevision, async (tx, show) => {
    const rounds = await loadLineup(tx, organizationId, competitionId, true);
    const from = rounds.find(round => round.id === roundId)?.status;
    assertRoundTransition(asLineup(rounds), roundId, to as RoundStatus, show.state);
    await tx`UPDATE rounds SET status = ${to as RoundStatus} WHERE organization_id = ${organizationId} AND id = ${roundId}`;
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: `round.${to as string}`, subjectType: "round", subjectId: roundId,
      details: { from, to }
    });
    return { roundId, status: to as RoundStatus };
  });
}

export async function transitionPerformance(
  organizationId: string, competitionId: string, actor: string, performanceId: string, to: unknown, expectedRevision?: number
): Promise<{ performanceId: string; status: PerformanceStatus }> {
  if (!["live", "completed", "skipped"].includes(to as string)) throw new DomainError("invalid_performance_status");
  return mutate(organizationId, competitionId, expectedRevision, async (tx, show) => {
    const rounds = await loadLineup(tx, organizationId, competitionId, true);
    const from = rounds.flatMap(round => round.performances).find(p => p.id === performanceId)?.status;
    assertPerformanceTransition(asLineup(rounds), performanceId, to as PerformanceStatus, show.state);
    if (to === "live") {
      await tx`UPDATE performances SET status = 'live', started_at = now() WHERE organization_id = ${organizationId} AND id = ${performanceId}`;
      await tx`UPDATE show_controls SET current_performance_id = ${performanceId}
        WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
    } else {
      await tx`UPDATE performances SET status = ${to as PerformanceStatus}, completed_at = now()
        WHERE organization_id = ${organizationId} AND id = ${performanceId}`;
      await tx`UPDATE show_controls SET current_performance_id = NULL
        WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND current_performance_id = ${performanceId}`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: `performance.${to as string}`, subjectType: "performance", subjectId: performanceId,
      details: { from, to }
    });
    return { performanceId, status: to as PerformanceStatus };
  });
}

/** Results visibility for a round (public scoreboard reads only published rounds). */
export async function setRoundPublication(
  organizationId: string, competitionId: string, actor: string, roundId: string,
  input: { published: unknown; expectedRevision?: number }
): Promise<{ roundId: string; resultsPublished: boolean; revision: number }> {
  if (typeof input.published !== "boolean") throw new DomainError("invalid_input");
  const published = input.published;
  return mutate(organizationId, competitionId, undefined, async tx => {
    if (!isUuid(roundId)) throw new DomainError("round_not_found");
    const [round] = await tx`SELECT 1 FROM rounds WHERE organization_id = ${organizationId}
      AND competition_id = ${competitionId} AND id = ${roundId}`;
    if (!round) throw new DomainError("round_not_found");
    const [current] = await tx<{ revision: number }[]>`SELECT revision FROM round_publications
      WHERE organization_id = ${organizationId} AND round_id = ${roundId} FOR UPDATE`;
    const currentRevision = current?.revision ?? 0;
    if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) throw new DomainError("publication_revision_conflict");
    const [row] = await tx<{ revision: number }[]>`
      INSERT INTO round_publications (organization_id, competition_id, round_id, results_published, updated_by_account_id)
      VALUES (${organizationId}, ${competitionId}, ${roundId}, ${published}, ${actor})
      ON CONFLICT (organization_id, round_id) DO UPDATE SET results_published = EXCLUDED.results_published,
        revision = round_publications.revision + 1, updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
      RETURNING revision
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId: actor, action: published ? "results.published" : "results.unpublished",
      subjectType: "round", subjectId: roundId, details: { competitionId, revision: row!.revision }
    });
    return { roundId, resultsPublished: published, revision: row!.revision };
  });
}
