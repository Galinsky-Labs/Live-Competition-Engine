import type postgres from "postgres";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import { validateReason } from "@live-competition-engine/domain/applications";
import { parseLineup, parsePanelRole, planLineup, type CurrentSlot, type PanelRole } from "@live-competition-engine/domain/selection";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-18 producer selection console services: round lineups (performance slots) with
 * optimistic revisions and append-only history, and per-round judge panels.
 * Callers must have authorized `event.manage` for the competition.
 */

export interface LineupSlot { performanceId: string; entryId: string; ordinal: number; status: CurrentSlot["status"]; displayName: string; }
export interface RoundLineup { roundId: string; revision: number; slots: LineupSlot[]; }
export interface PanelMember { judgeId: string; displayName: string; role: PanelRole; assignedAt: Date; }
export interface RoundPanel { roundId: string; assigned: PanelMember[]; available: { judgeId: string; displayName: string }[]; }

function ids(...values: string[]): void {
  if (!values.every(isUuid)) throw new DomainError("not_found");
}

async function loadRound(tx: Sql, organizationId: string, competitionId: string, roundId: string): Promise<{ id: string; status: string }> {
  const [round] = await tx<{ id: string; status: string }[]>`
    SELECT id, status FROM rounds WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${roundId}
  `;
  if (!round) throw new DomainError("round_not_found");
  return round;
}

async function readSlots(tx: Sql, organizationId: string, roundId: string): Promise<LineupSlot[]> {
  const rows = await tx<{ id: string; entry_id: string; ordinal: number; status: CurrentSlot["status"]; display_name: string }[]>`
    SELECT p.id, p.entry_id, p.ordinal, p.status, pa.display_name
    FROM performances p
    JOIN entries e ON e.organization_id = p.organization_id AND e.id = p.entry_id
    JOIN participants pa ON pa.organization_id = e.organization_id AND pa.id = e.participant_id
    WHERE p.organization_id = ${organizationId} AND p.round_id = ${roundId}
    ORDER BY p.ordinal
  `;
  return rows.map(r => ({ performanceId: r.id, entryId: r.entry_id, ordinal: r.ordinal, status: r.status, displayName: r.display_name }));
}

export async function getRoundLineup(organizationId: string, competitionId: string, roundId: string): Promise<RoundLineup> {
  ids(organizationId, competitionId, roundId);
  const sql = getSqlClient();
  await loadRound(sql, organizationId, competitionId, roundId);
  const [lineup] = await sql<{ revision: number }[]>`SELECT revision FROM round_lineups WHERE organization_id = ${organizationId} AND round_id = ${roundId}`;
  return { roundId, revision: lineup?.revision ?? 0, slots: await readSlots(sql, organizationId, roundId) };
}

/**
 * Replace a round's running order with `entryIds` (in order). Optimistic: the caller's
 * `expectedRevision` must match (0 for a round with no lineup yet), so two producers
 * editing at once produce one conflict. Started performances cannot move or be removed.
 */
export async function setRoundLineup(
  organizationId: string, competitionId: string, roundId: string, actorAccountId: string,
  input: { entryIds: unknown; expectedRevision: unknown; reason?: unknown }
): Promise<RoundLineup> {
  ids(organizationId, competitionId, roundId, actorAccountId);
  const desired = parseLineup(input.entryIds);
  const expected = input.expectedRevision;
  if (!Number.isSafeInteger(expected) || (expected as number) < 0) throw new DomainError("invalid_expected_revision");
  const reason = validateReason(input.reason, false);
  try {
    return await getSqlClient().begin(async tx => {
      const round = await loadRound(tx, organizationId, competitionId, roundId);
      if (round.status === "completed" || round.status === "cancelled") throw new DomainError("invalid_state_round_closed");
      await tx`INSERT INTO round_lineups (round_id, organization_id, competition_id) VALUES (${roundId}, ${organizationId}, ${competitionId})
        ON CONFLICT (round_id) DO NOTHING`;
      const [lineup] = await tx<{ revision: number }[]>`SELECT revision FROM round_lineups WHERE organization_id = ${organizationId} AND round_id = ${roundId} FOR UPDATE`;
      if (!lineup || lineup.revision !== expected) throw new DomainError("lineup_revision_conflict");
      const current = await readSlots(tx, organizationId, roundId);
      const plan = planLineup(current, desired);
      const started = new Set(current.filter(s => s.status !== "queued").map(s => s.entryId));
      const needEligible = desired.filter(id => !started.has(id));
      if (needEligible.length) {
        const eligible = await tx<{ id: string }[]>`
          SELECT id FROM entries WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
            AND status = 'approved' AND id = ANY(${needEligible}::uuid[])
        `;
        if (eligible.length !== needEligible.length) throw new DomainError("entry_not_eligible");
      }
      if (plan.deletes.length) {
        await tx`DELETE FROM performances WHERE organization_id = ${organizationId} AND round_id = ${roundId}
          AND status = 'queued' AND id = ANY(${plan.deletes}::uuid[])`;
      }
      // Two-phase renumbering avoids transient (round_id, ordinal) collisions.
      for (const move of plan.moves) {
        await tx`UPDATE performances SET ordinal = ${move.ordinal + 1_000_000} WHERE organization_id = ${organizationId} AND id = ${move.performanceId}`;
      }
      for (const move of plan.moves) {
        await tx`UPDATE performances SET ordinal = ${move.ordinal} WHERE organization_id = ${organizationId} AND id = ${move.performanceId}`;
      }
      for (const insert of plan.inserts) {
        await tx`INSERT INTO performances (organization_id, competition_id, round_id, entry_id, ordinal)
          VALUES (${organizationId}, ${competitionId}, ${roundId}, ${insert.entryId}, ${insert.ordinal})`;
      }
      const [updated] = await tx<{ revision: number }[]>`
        UPDATE round_lineups SET revision = revision + 1, updated_by_account_id = ${actorAccountId}, updated_at = now()
        WHERE round_id = ${roundId} RETURNING revision
      `;
      await tx`INSERT INTO round_lineup_history (organization_id, round_id, revision, entries, actor_account_id, reason)
        VALUES (${organizationId}, ${roundId}, ${updated!.revision}, ${tx.json(plan.order as unknown as postgres.JSONValue)}, ${actorAccountId}, ${reason})`;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "round.lineup_updated", subjectType: "round", subjectId: roundId,
        details: { competitionId, revision: updated!.revision, entryIds: desired, moved: plan.moves.length, added: plan.inserts.length, removed: plan.deletes.length, reason }
      });
      return { roundId, revision: updated!.revision, slots: await readSlots(tx, organizationId, roundId) };
    });
  } catch (error) {
    // A queued slot that already carries scores or critiques cannot be deleted.
    if ((error as { code?: string }).code === "23503") throw new DomainError("invalid_state_slot_has_records");
    throw error;
  }
}

export async function listLineupHistory(organizationId: string, competitionId: string, roundId: string) {
  ids(organizationId, competitionId, roundId);
  const sql = getSqlClient();
  await loadRound(sql, organizationId, competitionId, roundId);
  const rows = await sql<{ revision: number; entries: { entryId: string; ordinal: number }[]; actor_account_id: string; reason: string | null; recorded_at: Date }[]>`
    SELECT revision, entries, actor_account_id, reason, recorded_at FROM round_lineup_history
    WHERE organization_id = ${organizationId} AND round_id = ${roundId} ORDER BY revision
  `;
  return rows.map(r => ({ revision: r.revision, entries: r.entries, actorAccountId: r.actor_account_id, reason: r.reason, recordedAt: r.recorded_at }));
}

export async function getRoundPanel(organizationId: string, competitionId: string, roundId: string, sql: Sql = getSqlClient()): Promise<RoundPanel> {
  ids(organizationId, competitionId, roundId);
  await loadRound(sql, organizationId, competitionId, roundId);
  const assigned = await sql<{ judge_id: string; display_name: string; panel_role: PanelRole; assigned_at: Date }[]>`
    SELECT p.judge_id, j.display_name, p.panel_role, p.assigned_at FROM round_judge_panels p
    JOIN judges j ON j.organization_id = p.organization_id AND j.id = p.judge_id
    WHERE p.organization_id = ${organizationId} AND p.round_id = ${roundId} AND p.removed_at IS NULL
    ORDER BY (p.panel_role = 'head') DESC, j.display_name, p.judge_id
  `;
  const available = await sql<{ judge_id: string; display_name: string }[]>`
    SELECT cj.judge_id, j.display_name FROM competition_judges cj
    JOIN judges j ON j.organization_id = cj.organization_id AND j.id = cj.judge_id
    WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${competitionId}
      AND ${eligibleJudge(sql)}
    ORDER BY j.display_name, cj.judge_id
  `;
  return {
    roundId,
    assigned: assigned.map(a => ({ judgeId: a.judge_id, displayName: a.display_name, role: a.panel_role, assignedAt: a.assigned_at })),
    available: available.map(a => ({ judgeId: a.judge_id, displayName: a.display_name }))
  };
}

/**
 * A competition judge is eligible for panels unless LC-19 marked them removed/suspended.
 * Expects the alias `cj` for competition_judges.
 */
function eligibleJudge(sql: Sql) {
  return sql`NOT EXISTS (SELECT 1 FROM competition_judge_states s WHERE s.competition_id = cj.competition_id
    AND s.judge_id = cj.judge_id AND s.status IN ('suspended','removed'))`;
}

/** Assign (or change the role of) a competition judge on a round panel. Idempotent. */
export async function assignJudgeToRound(
  organizationId: string, competitionId: string, roundId: string, actorAccountId: string, input: { judgeId: unknown; role?: unknown }
): Promise<RoundPanel> {
  ids(organizationId, competitionId, roundId, actorAccountId);
  if (!isUuid(input.judgeId)) throw new DomainError("judge_not_found");
  const judgeId = input.judgeId;
  const role = parsePanelRole(input.role);
  try {
    return await getSqlClient().begin(async tx => {
      const round = await loadRound(tx, organizationId, competitionId, roundId);
      if (round.status === "completed" || round.status === "cancelled") throw new DomainError("invalid_state_round_closed");
      const [judge] = await tx`SELECT 1 FROM competition_judges cj WHERE cj.organization_id = ${organizationId}
        AND cj.competition_id = ${competitionId} AND cj.judge_id = ${judgeId} AND ${eligibleJudge(tx)} FOR SHARE`;
      if (!judge) throw new DomainError("judge_not_found");
      const [existing] = await tx<{ id: string; panel_role: PanelRole }[]>`
        SELECT id, panel_role FROM round_judge_panels WHERE organization_id = ${organizationId} AND round_id = ${roundId}
          AND judge_id = ${judgeId} AND removed_at IS NULL FOR UPDATE
      `;
      if (existing?.panel_role === role) return getRoundPanel(organizationId, competitionId, roundId, tx);
      if (existing) {
        await tx`UPDATE round_judge_panels SET removed_at = now(), removed_by_account_id = ${actorAccountId} WHERE id = ${existing.id}`;
      }
      await tx`INSERT INTO round_judge_panels (organization_id, competition_id, round_id, judge_id, panel_role, assigned_by_account_id)
        VALUES (${organizationId}, ${competitionId}, ${roundId}, ${judgeId}, ${role}, ${actorAccountId})`;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "round.judge_assigned", subjectType: "round", subjectId: roundId,
        details: { competitionId, judgeId, role, previousRole: existing?.panel_role ?? null }
      });
      return getRoundPanel(organizationId, competitionId, roundId, tx);
    });
  } catch (error) {
    if ((error as { code?: string; constraint_name?: string }).constraint_name === "round_judge_panels_one_head_uniq") throw new DomainError("panel_head_conflict");
    if ((error as { constraint_name?: string }).constraint_name === "round_judge_panels_active_uniq") throw new DomainError("panel_assignment_conflict");
    throw error;
  }
}

export async function removeJudgeFromRound(
  organizationId: string, competitionId: string, roundId: string, actorAccountId: string, judgeId: unknown
): Promise<RoundPanel> {
  ids(organizationId, competitionId, roundId, actorAccountId);
  if (!isUuid(judgeId)) throw new DomainError("panel_assignment_not_found");
  return getSqlClient().begin(async tx => {
    await loadRound(tx, organizationId, competitionId, roundId);
    const removed = await tx`UPDATE round_judge_panels SET removed_at = now(), removed_by_account_id = ${actorAccountId}
      WHERE organization_id = ${organizationId} AND round_id = ${roundId} AND judge_id = ${judgeId} AND removed_at IS NULL RETURNING id`;
    if (!removed.length) throw new DomainError("panel_assignment_not_found");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "round.judge_removed", subjectType: "round", subjectId: roundId, details: { competitionId, judgeId }
    });
    return getRoundPanel(organizationId, competitionId, roundId, tx);
  });
}

/** Console overview: competition, application counts by status, capacity and rounds. */
export async function getSelectionSummary(organizationId: string, competitionId: string) {
  ids(organizationId, competitionId);
  const sql = getSqlClient();
  const [competition] = await sql<{ id: string; title: string; status: string }[]>`
    SELECT id, title, status FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
  if (!competition) throw new DomainError("competition_not_found");
  const counts = await sql<{ status: string; count: number }[]>`
    SELECT status, count(*)::int AS count FROM applications WHERE organization_id = ${organizationId}
      AND competition_id = ${competitionId} AND submitted_at IS NOT NULL GROUP BY status`;
  const [form] = await sql<{ capacity: number | null; closes_at: Date }[]>`
    SELECT capacity, closes_at FROM application_forms WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
  const rounds = await sql<{ id: string; label: string; ordinal: number; status: string; revision: number | null }[]>`
    SELECT r.id, r.label, r.ordinal, r.status, l.revision FROM rounds r
    LEFT JOIN round_lineups l ON l.round_id = r.id
    WHERE r.organization_id = ${organizationId} AND r.competition_id = ${competitionId} ORDER BY r.ordinal`;
  return {
    competition,
    capacity: form?.capacity ?? null,
    closesAt: form?.closes_at ?? null,
    counts: Object.fromEntries(counts.map(c => [c.status, c.count])),
    rounds: rounds.map(r => ({ id: r.id, label: r.label, ordinal: r.ordinal, status: r.status, lineupRevision: r.revision ?? 0 }))
  };
}
