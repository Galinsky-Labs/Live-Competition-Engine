import {
  assertStageTransition, DomainError, parseContestConfig, planRoundRobin, planSingleElimination,
  selectAdvancing, stageInputSchema, advancementRuleSchema, type AdvancementRule, type Standing, type StageStatus
} from "@live-competition-engine/engine";
import type { TransactionSql } from "postgres";
import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";
import { lockEvent } from "./events.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireId = (value: unknown, code: string) => {
  if (typeof value !== "string" || !uuid.test(value)) throw new DomainError(400, code);
  return value;
};

/* ---------- entrants ---------- */

export interface EntrantRecord { entryId: string; participantId: string; displayName: string; kind: "individual" | "group"; status: string; accountId: string | null; members: string[] }

export async function addEntrantTx(tx: TransactionSql, organizationId: string, eventId: string, actorAccountId: string,
  input: { displayName: unknown; kind?: unknown; accountId?: string | null; members?: unknown }, source: string): Promise<EntrantRecord> {
  const event = await lockEvent(tx, organizationId, eventId);
  if (event.status === "completed" || event.status === "cancelled") throw new DomainError(409, "event_closed");
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (displayName.length < 1 || displayName.length > 120) throw new DomainError(400, "invalid_display_name");
  const kind = input.kind === "group" ? "group" : "individual";
  const members = Array.isArray(input.members) ? input.members.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map(m => m.trim().slice(0, 120)) : [];
  const config = parseContestConfig(event.config);
  if (config.format === "group" || kind === "group") {
    const size = config.eligibility.groupSize;
    if (kind !== "group") throw new DomainError(400, "group_entrant_required");
    if (size && (members.length < size.min || members.length > size.max)) throw new DomainError(400, "group_size_out_of_range");
  }
  if (config.eligibility.maxEntrants) {
    const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM entries WHERE competition_id = ${eventId} AND status = 'approved'`;
    if (count!.n >= config.eligibility.maxEntrants) throw new DomainError(409, "event_full");
  }
  const [participant] = await tx<{ id: string }[]>`
    INSERT INTO participants (organization_id, display_name, kind, account_id) VALUES (${organizationId}, ${displayName}, ${kind}, ${input.accountId ?? null}) RETURNING id`;
  for (const member of members) {
    const [m] = await tx<{ id: string }[]>`INSERT INTO participants (organization_id, display_name) VALUES (${organizationId}, ${member}) RETURNING id`;
    await tx`INSERT INTO participant_group_members (organization_id, group_participant_id, member_participant_id) VALUES (${organizationId}, ${participant!.id}, ${m!.id})`;
  }
  const [entry] = await tx<{ id: string }[]>`
    INSERT INTO entries (organization_id, competition_id, participant_id, status) VALUES (${organizationId}, ${eventId}, ${participant!.id}, 'approved') RETURNING id`;
  await recordAudit(tx, { organizationId, actorAccountId, action: "entrant.added", subjectType: "entry", subjectId: entry!.id, details: { eventId, source, kind } });
  return { entryId: entry!.id, participantId: participant!.id, displayName, kind, status: "approved", accountId: input.accountId ?? null, members };
}

export function addEntrant(organizationId: string, eventId: string, actorAccountId: string, input: { displayName: unknown; kind?: unknown; members?: unknown }) {
  return getSqlClient().begin(tx => addEntrantTx(tx, organizationId, eventId, actorAccountId, input, "producer"));
}

export async function listEntrants(organizationId: string, eventId: string): Promise<EntrantRecord[]> {
  const rows = await getSqlClient()<{ entry_id: string; participant_id: string; display_name: string; kind: "individual" | "group"; status: string; account_id: string | null; members: string[] }[]>`
    SELECT e.id AS entry_id, p.id AS participant_id, p.display_name, p.kind, e.status::text AS status, p.account_id,
      COALESCE((SELECT array_agg(mp.display_name ORDER BY mp.display_name) FROM participant_group_members gm
        JOIN participants mp ON mp.id = gm.member_participant_id WHERE gm.group_participant_id = p.id), '{}') AS members
    FROM entries e JOIN participants p ON p.id = e.participant_id AND p.organization_id = e.organization_id
    WHERE e.organization_id = ${organizationId} AND e.competition_id = ${eventId}
    ORDER BY e.created_at`;
  return rows.map(r => ({ entryId: r.entry_id, participantId: r.participant_id, displayName: r.display_name, kind: r.kind, status: r.status, accountId: r.account_id, members: r.members }));
}

export async function setEntrantStatus(organizationId: string, eventId: string, entryId: unknown, actorAccountId: string, status: unknown, reason: unknown) {
  const id = requireId(entryId, "invalid_entry_id");
  if (status !== "withdrawn" && status !== "disqualified" && status !== "approved") throw new DomainError(400, "invalid_entry_status");
  if (status === "disqualified" && (typeof reason !== "string" || reason.trim().length < 3)) throw new DomainError(400, "reason_required");
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const [row] = await tx<{ id: string }[]>`UPDATE entries SET status = ${status} WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND id = ${id} RETURNING id`;
    if (!row) throw new DomainError(404, "entry_not_found");
    if (status !== "approved") await tx`UPDATE stage_entrants SET status = 'withdrawn' WHERE competition_id = ${eventId} AND entry_id = ${id} AND status = 'active'`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "entrant.status_changed", subjectType: "entry", subjectId: id, details: { status, ...(typeof reason === "string" ? { reason } : {}) } });
    return { entryId: id, status };
  });
}

/* ---------- stages ---------- */

export interface StageRecord {
  id: string; label: string; ordinal: number; status: StageStatus; kind: string; format: string; timed: boolean;
  durationSeconds: number | null; advancement: AdvancementRule; revision: number; scheduledAt: Date | null; startedAt: Date | null; completedAt: Date | null;
}
interface StageRow { id: string; label: string; ordinal: number; status: StageStatus; kind: string; format: string; timed: boolean; duration_seconds: number | null; advancement: AdvancementRule; revision: number; scheduled_at: Date | null; started_at: Date | null; completed_at: Date | null }
const toStage = (r: StageRow): StageRecord => ({ id: r.id, label: r.label, ordinal: r.ordinal, status: r.status, kind: r.kind, format: r.format, timed: r.timed, durationSeconds: r.duration_seconds, advancement: r.advancement, revision: r.revision, scheduledAt: r.scheduled_at, startedAt: r.started_at, completedAt: r.completed_at });
const stageColumns = "id, label, ordinal, status, kind, format, timed, duration_seconds, advancement, revision, scheduled_at, started_at, completed_at";

export async function lockStage(tx: TransactionSql, organizationId: string, eventId: string, stageId: unknown): Promise<StageRecord> {
  const id = requireId(stageId, "invalid_stage_id");
  const [row] = await tx.unsafe<StageRow[]>(`SELECT ${stageColumns} FROM rounds WHERE organization_id = $1 AND competition_id = $2 AND id = $3 FOR UPDATE`, [organizationId, eventId, id]);
  if (!row) throw new DomainError(404, "stage_not_found");
  return toStage(row);
}

export async function listStages(organizationId: string, eventId: string): Promise<StageRecord[]> {
  const rows = await getSqlClient().unsafe<StageRow[]>(`SELECT ${stageColumns} FROM rounds WHERE organization_id = $1 AND competition_id = $2 ORDER BY ordinal`, [organizationId, eventId]);
  return rows.map(toStage);
}

export async function createStage(organizationId: string, eventId: string, actorAccountId: string, input: unknown): Promise<StageRecord> {
  const data = stageInputSchema.parse(input);
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status === "completed" || event.status === "cancelled") throw new DomainError(409, "event_closed");
    const [row] = await tx.unsafe<StageRow[]>(
      `INSERT INTO rounds (organization_id, competition_id, label, ordinal, kind, format, timed, duration_seconds, advancement, scheduled_at)
       SELECT $1, $2, $3, COALESCE(MAX(ordinal), 0) + 1, $4, $5, $6, $7, $8, $9 FROM rounds WHERE competition_id = $2
       RETURNING ${stageColumns}`,
      [organizationId, eventId, data.label, data.kind, data.format, data.timed, data.durationSeconds ?? null, tx.json(data.advancement as never), data.scheduledAt ?? null] as never[]
    );
    await recordAudit(tx, { organizationId, actorAccountId, action: "stage.created", subjectType: "stage", subjectId: row!.id, details: { eventId, label: data.label, kind: data.kind } });
    return toStage(row!);
  });
}

export async function updateStage(organizationId: string, eventId: string, stageId: unknown, actorAccountId: string, expectedRevision: unknown, input: unknown): Promise<StageRecord> {
  return getSqlClient().begin(async tx => {
    const stage = await lockStage(tx, organizationId, eventId, stageId);
    if (stage.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    if (stage.status !== "scheduled") throw new DomainError(409, "stage_locked");
    const data = stageInputSchema.parse({ label: stage.label, kind: stage.kind, format: stage.format, timed: stage.timed, durationSeconds: stage.durationSeconds, advancement: stage.advancement, ...(input as object) });
    const [row] = await tx.unsafe<StageRow[]>(
      `UPDATE rounds SET label = $2, kind = $3, format = $4, timed = $5, duration_seconds = $6, advancement = $7, revision = revision + 1
       WHERE id = $1 RETURNING ${stageColumns}`,
      [stage.id, data.label, data.kind, data.format, data.timed, data.durationSeconds ?? null, tx.json(data.advancement as never)] as never[]
    );
    await recordAudit(tx, { organizationId, actorAccountId, action: "stage.updated", subjectType: "stage", subjectId: stage.id, details: { revision: row!.revision } });
    return toStage(row!);
  });
}

export async function transitionStage(organizationId: string, eventId: string, stageId: unknown, actorAccountId: string, to: StageStatus, expectedRevision: unknown): Promise<StageRecord> {
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    const stage = await lockStage(tx, organizationId, eventId, stageId);
    if (stage.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    assertStageTransition(stage.status, to);
    if (to === "live") {
      if (event.status !== "live") throw new DomainError(409, "event_not_live");
      const [other] = await tx`SELECT id FROM rounds WHERE competition_id = ${eventId} AND status = 'live' AND id <> ${stage.id}`;
      if (other) throw new DomainError(409, "another_stage_live");
    }
    const [row] = await tx.unsafe<StageRow[]>(
      `UPDATE rounds SET status = $2::round_status, revision = revision + 1,
         started_at = CASE WHEN $3::text = 'live' THEN now() ELSE started_at END,
         completed_at = CASE WHEN $3::text IN ('completed', 'cancelled') THEN now() ELSE completed_at END
       WHERE id = $1 RETURNING ${stageColumns}`, [stage.id, to, to]);
    await recordAudit(tx, { organizationId, actorAccountId, action: `stage.${to}`, subjectType: "stage", subjectId: stage.id, details: { from: stage.status } });
    return toStage(row!);
  });
}

export interface StageEntrant { entryId: string; displayName: string; seed: number | null; status: string }

export async function listStageEntrants(organizationId: string, eventId: string, stageId: string): Promise<StageEntrant[]> {
  const rows = await getSqlClient()<{ entry_id: string; display_name: string; seed: number | null; status: string }[]>`
    SELECT se.entry_id, p.display_name, se.seed, se.status
    FROM stage_entrants se JOIN entries e ON e.id = se.entry_id JOIN participants p ON p.id = e.participant_id
    WHERE se.organization_id = ${organizationId} AND se.competition_id = ${eventId} AND se.round_id = ${stageId}
    ORDER BY se.seed NULLS LAST, se.added_at`;
  return rows.map(r => ({ entryId: r.entry_id, displayName: r.display_name, seed: r.seed, status: r.status }));
}

/** Replaces the stage's entrant list (scheduled stages only). Entries must be approved entries of this event. */
export async function setStageEntrants(organizationId: string, eventId: string, stageId: unknown, actorAccountId: string, entries: unknown) {
  if (!Array.isArray(entries) || entries.length > 1024) throw new DomainError(400, "invalid_entrants");
  const ids = entries.map(e => requireId(e, "invalid_entry_id"));
  if (new Set(ids).size !== ids.length) throw new DomainError(400, "duplicate_entrant");
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const stage = await lockStage(tx, organizationId, eventId, stageId);
    if (stage.status !== "scheduled") throw new DomainError(409, "stage_locked");
    const [hasMatchups] = await tx`SELECT 1 FROM matchups WHERE round_id = ${stage.id} LIMIT 1`;
    if (hasMatchups) throw new DomainError(409, "bracket_already_generated");
    const valid = ids.length ? await tx<{ id: string }[]>`SELECT id FROM entries WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND status = 'approved' AND id IN ${tx(ids)}` : [];
    if (valid.length !== ids.length) throw new DomainError(400, "entry_not_eligible");
    await tx`DELETE FROM stage_entrants WHERE round_id = ${stage.id}`;
    for (const [index, id] of ids.entries()) {
      await tx`INSERT INTO stage_entrants (organization_id, competition_id, round_id, entry_id, seed) VALUES (${organizationId}, ${eventId}, ${stage.id}, ${id}, ${index + 1})`;
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "stage.entrants_set", subjectType: "stage", subjectId: stage.id, details: { count: ids.length } });
    return ids.length;
  });
}

/**
 * Moves entrants from a completed stage into a later scheduled stage according to the source
 * stage's advancement contract. Standings come from scoring (LC-20) or from the producer.
 */
export async function advanceStage(organizationId: string, eventId: string, fromStageId: unknown, toStageId: unknown, actorAccountId: string,
  standings: Standing[], manualSelection: string[] = []) {
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const from = await lockStage(tx, organizationId, eventId, fromStageId);
    const to = await lockStage(tx, organizationId, eventId, toStageId);
    if (from.status !== "completed") throw new DomainError(409, "source_stage_not_completed");
    if (to.status !== "scheduled") throw new DomainError(409, "target_stage_locked");
    if (to.ordinal <= from.ordinal) throw new DomainError(400, "target_stage_must_follow_source");
    const current = await tx<{ entry_id: string }[]>`SELECT entry_id FROM stage_entrants WHERE round_id = ${from.id} AND status IN ('active', 'advanced', 'eliminated')`;
    const inStage = new Set(current.map(r => r.entry_id));
    let advancing: string[];
    const rule = advancementRuleSchema.parse(from.advancement);
    if (rule.type === "bracket_winners") {
      const [final] = await tx<{ winner_entry_id: string | null }[]>`SELECT winner_entry_id FROM matchups WHERE round_id = ${from.id} AND next_matchup_id IS NULL ORDER BY bracket_round DESC LIMIT 1`;
      if (!final?.winner_entry_id) throw new DomainError(409, "bracket_not_decided");
      advancing = [final.winner_entry_id];
    } else {
      const filtered = standings.filter(s => inStage.has(s.entryId));
      advancing = selectAdvancing(rule, filtered, manualSelection);
    }
    const rankOf = new Map(standings.map(s => [s.entryId, s.rank]));
    advancing.sort((a, b) => (rankOf.get(a) ?? 1e9) - (rankOf.get(b) ?? 1e9));
    const [existing] = await tx`SELECT 1 FROM stage_entrants WHERE round_id = ${to.id} LIMIT 1`;
    if (existing) throw new DomainError(409, "target_stage_already_seeded");
    await tx`UPDATE stage_entrants SET status = CASE WHEN entry_id IN ${tx(advancing.length ? advancing : ["00000000-0000-0000-0000-000000000000"])} THEN 'advanced' ELSE 'eliminated' END
      WHERE round_id = ${from.id} AND status IN ('active', 'advanced', 'eliminated')`;
    for (const [index, entryId] of advancing.entries()) {
      await tx`INSERT INTO stage_entrants (organization_id, competition_id, round_id, entry_id, seed, source_round_id)
        VALUES (${organizationId}, ${eventId}, ${to.id}, ${entryId}, ${index + 1}, ${from.id})`;
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "stage.advanced", subjectType: "stage", subjectId: from.id, details: { toStageId: to.id, rule: rule.type, advancing } });
    return advancing;
  });
}

/* ---------- brackets ---------- */

export interface MatchupRecord {
  id: string; bracketRound: number; slot: number; entryAId: string | null; entryBId: string | null; seedA: number | null; seedB: number | null;
  winnerEntryId: string | null; status: string; nextMatchupId: string | null; nextSide: "a" | "b" | null; revision: number; decisionReason: string | null;
}
interface MatchupRow { id: string; bracket_round: number; slot: number; entry_a_id: string | null; entry_b_id: string | null; seed_a: number | null; seed_b: number | null; winner_entry_id: string | null; status: string; next_matchup_id: string | null; next_side: "a" | "b" | null; revision: number; decision_reason: string | null }
const toMatchup = (r: MatchupRow): MatchupRecord => ({ id: r.id, bracketRound: r.bracket_round, slot: r.slot, entryAId: r.entry_a_id, entryBId: r.entry_b_id, seedA: r.seed_a, seedB: r.seed_b, winnerEntryId: r.winner_entry_id, status: r.status, nextMatchupId: r.next_matchup_id, nextSide: r.next_side, revision: r.revision, decisionReason: r.decision_reason });

export async function listMatchups(organizationId: string, eventId: string, stageId: string): Promise<MatchupRecord[]> {
  const rows = await getSqlClient()<MatchupRow[]>`
    SELECT id, bracket_round, slot, entry_a_id, entry_b_id, seed_a, seed_b, winner_entry_id, status, next_matchup_id, next_side, revision, decision_reason
    FROM matchups WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND round_id = ${stageId}
    ORDER BY bracket_round, slot`;
  return rows.map(toMatchup);
}

export async function generateBracket(organizationId: string, eventId: string, stageId: unknown, actorAccountId: string): Promise<MatchupRecord[]> {
  const created = await getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const stage = await lockStage(tx, organizationId, eventId, stageId);
    if (stage.format !== "head_to_head" && stage.format !== "round_robin") throw new DomainError(409, "stage_not_head_to_head");
    if (stage.status !== "scheduled") throw new DomainError(409, "stage_locked");
    const [existing] = await tx`SELECT 1 FROM matchups WHERE round_id = ${stage.id} LIMIT 1`;
    if (existing) throw new DomainError(409, "bracket_already_generated");
    const entrants = await tx<{ entry_id: string; seed: number | null }[]>`
      SELECT entry_id, seed FROM stage_entrants WHERE round_id = ${stage.id} AND status = 'active' ORDER BY seed NULLS LAST, added_at`;
    const seeded = entrants.map(e => e.entry_id);
    if (stage.format === "round_robin") {
      for (const pair of planRoundRobin(seeded)) {
        await tx`INSERT INTO matchups (organization_id, competition_id, round_id, bracket_round, slot, entry_a_id, entry_b_id, status)
          VALUES (${organizationId}, ${eventId}, ${stage.id}, ${pair.round}, ${pair.slot}, ${pair.entryA}, ${pair.entryB}, 'ready')`;
      }
    } else {
      const plan = planSingleElimination(seeded);
      const ids = new Map<string, string>();
      // Insert from the final backwards so next_matchup_id references exist.
      for (const m of [...plan].sort((a, b) => b.round - a.round)) {
        const nextId = m.next ? ids.get(`${m.next.round}:${m.next.slot}`)! : null;
        const status = m.byeWinner ? "bye" : m.entryA && m.entryB ? "ready" : "pending";
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO matchups (organization_id, competition_id, round_id, bracket_round, slot, entry_a_id, entry_b_id, seed_a, seed_b, winner_entry_id, status, next_matchup_id, next_side)
          VALUES (${organizationId}, ${eventId}, ${stage.id}, ${m.round}, ${m.slot}, ${m.entryA}, ${m.entryB}, ${m.seedA}, ${m.seedB}, ${m.byeWinner}, ${status}, ${nextId}, ${m.next?.side ?? null})
          RETURNING id`;
        ids.set(`${m.round}:${m.slot}`, row!.id);
      }
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "bracket.generated", subjectType: "stage", subjectId: stage.id, details: { format: stage.format, entrants: seeded.length } });
    return stage.id;
  });
  return listMatchups(organizationId, eventId, created);
}

/** Records (or corrects, with a reason) a matchup winner and feeds the next matchup. */
export async function decideMatchup(organizationId: string, eventId: string, matchupId: unknown, actorAccountId: string, winnerEntryId: unknown, expectedRevision: unknown, reason?: unknown): Promise<MatchupRecord> {
  const id = requireId(matchupId, "invalid_matchup_id");
  const winner = requireId(winnerEntryId, "invalid_entry_id");
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const [m] = await tx<MatchupRow[]>`
      SELECT id, bracket_round, slot, entry_a_id, entry_b_id, seed_a, seed_b, winner_entry_id, status, next_matchup_id, next_side, revision, decision_reason
      FROM matchups WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND id = ${id} FOR UPDATE`;
    if (!m) throw new DomainError(404, "matchup_not_found");
    if (m.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    const [stage] = await tx<{ status: string; format: string }[]>`SELECT r.status::text AS status, r.format FROM rounds r JOIN matchups x ON x.round_id = r.id WHERE x.id = ${id}`;
    if (stage!.status !== "live") throw new DomainError(409, "stage_not_live");
    if (m.status === "pending" || m.status === "bye") throw new DomainError(409, "matchup_not_ready");
    if (winner !== m.entry_a_id && winner !== m.entry_b_id) throw new DomainError(400, "winner_not_in_matchup");
    const correcting = m.status === "decided";
    if (correcting) {
      if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "correction_reason_required");
      if (m.winner_entry_id === winner) throw new DomainError(409, "no_change");
    }
    if (m.next_matchup_id) {
      const [next] = await tx<{ status: string }[]>`SELECT status FROM matchups WHERE id = ${m.next_matchup_id} FOR UPDATE`;
      if (correcting && next!.status === "decided") throw new DomainError(409, "downstream_matchup_already_decided");
      const seed = winner === m.entry_a_id ? m.seed_a : m.seed_b;
      if (m.next_side === "a") await tx`UPDATE matchups SET entry_a_id = ${winner}, seed_a = ${seed}, revision = revision + 1 WHERE id = ${m.next_matchup_id}`;
      else await tx`UPDATE matchups SET entry_b_id = ${winner}, seed_b = ${seed}, revision = revision + 1 WHERE id = ${m.next_matchup_id}`;
      await tx`UPDATE matchups SET status = CASE WHEN entry_a_id IS NOT NULL AND entry_b_id IS NOT NULL THEN 'ready' ELSE 'pending' END WHERE id = ${m.next_matchup_id}`;
    }
    const loser = winner === m.entry_a_id ? m.entry_b_id : m.entry_a_id;
    const [row] = await tx<MatchupRow[]>`
      UPDATE matchups SET winner_entry_id = ${winner}, status = 'decided', decided_by_account_id = ${actorAccountId}, decided_at = now(),
        decision_reason = ${typeof reason === "string" ? reason.trim() : null}, revision = revision + 1
      WHERE id = ${id}
      RETURNING id, bracket_round, slot, entry_a_id, entry_b_id, seed_a, seed_b, winner_entry_id, status, next_matchup_id, next_side, revision, decision_reason`;
    // Elimination: the loser is out (round-robin keeps everyone active).
    if (stage!.format === "head_to_head") {
      await tx`UPDATE stage_entrants SET status = 'eliminated' WHERE round_id = (SELECT round_id FROM matchups WHERE id = ${id}) AND entry_id = ${loser}`;
      if (correcting) await tx`UPDATE stage_entrants SET status = 'active' WHERE round_id = (SELECT round_id FROM matchups WHERE id = ${id}) AND entry_id = ${winner}`;
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: correcting ? "matchup.corrected" : "matchup.decided", subjectType: "matchup", subjectId: id, details: { winner, previousWinner: m.winner_entry_id, ...(correcting ? { reason } : {}) } });
    return toMatchup(row!);
  });
}
