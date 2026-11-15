import type postgres from "postgres";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  assertPermutation,
  computeAdvancement,
  parseStageDefinition,
  type AdvancementContract,
  type AdvancementOutcome,
  type StageDefinition,
  type Standing
} from "@live-competition-engine/domain/stages";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-15 stages. Design: a stage is a 1:1 extension of a `rounds` row (rounds keep
 * label, ordinal and status; results keep referencing rounds), adding kind, timing
 * and an advancement contract. Ordering is `rounds.ordinal`.
 */
export interface StageRecord extends StageDefinition {
  id: string;
  competitionId: string;
  roundId: string;
  ordinal: number;
  roundStatus: string;
  revision: number;
  decided: boolean;
}

export interface AdvancementDecision extends AdvancementOutcome {
  id: string;
  stageId: string;
  contract: AdvancementContract;
  standings: Standing[];
  decidedByAccountId: string;
  decidedAt: Date;
  replayed: boolean;
}

interface StageRow {
  id: string; competition_id: string; round_id: string; ordinal: number; round_status: string; label: string;
  kind: StageDefinition["kind"]; custom_label: string | null; timed: boolean; duration_seconds: number | null;
  advancement: AdvancementContract | null; revision: number; decided: boolean;
}

const toStage = (row: StageRow): StageRecord => ({
  id: row.id, competitionId: row.competition_id, roundId: row.round_id, ordinal: row.ordinal, roundStatus: row.round_status,
  label: row.label, kind: row.kind, customLabel: row.custom_label, timed: row.timed, durationSeconds: row.duration_seconds,
  advancement: row.advancement, revision: row.revision, decided: row.decided
});

const SELECT_STAGE = (sql: Sql) => sql`
  SELECT s.id, s.competition_id, s.round_id, r.ordinal, r.status::text AS round_status, r.label, s.kind, s.custom_label,
    s.timed, s.duration_seconds, s.advancement, s.revision,
    EXISTS (SELECT 1 FROM stage_advancements a WHERE a.stage_id = s.id) AS decided
  FROM stages s JOIN rounds r ON r.organization_id = s.organization_id AND r.id = s.round_id
`;

const jsonValue = (tx: Sql, value: unknown) => tx.json(value as postgres.JSONValue);

async function lockOpenEvent(tx: Sql, organizationId: string, competitionId: string): Promise<void> {
  if (!isUuid(organizationId) || !isUuid(competitionId)) throw new DomainError("event_not_found");
  const [event] = await tx<{ status: string }[]>`
    SELECT status FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId} FOR UPDATE
  `;
  if (!event) throw new DomainError("event_not_found");
  if (event.status === "completed" || event.status === "cancelled") throw new DomainError("invalid_state_event_closed");
}

export async function listStages(organizationId: string, competitionId: string): Promise<StageRecord[]> {
  if (!isUuid(organizationId) || !isUuid(competitionId)) return [];
  const sql = getSqlClient();
  const rows = await sql<StageRow[]>`
    ${SELECT_STAGE(sql)} WHERE s.organization_id = ${organizationId} AND s.competition_id = ${competitionId} ORDER BY r.ordinal
  `;
  return rows.map(toStage);
}

export async function createStage(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  body: Record<string, unknown>
): Promise<StageRecord> {
  const definition = parseStageDefinition(body);
  return getSqlClient().begin(async tx => {
    await lockOpenEvent(tx, organizationId, competitionId);
    const [round] = await tx<{ id: string }[]>`
      INSERT INTO rounds (organization_id, competition_id, label, ordinal)
      SELECT ${organizationId}, ${competitionId}, ${definition.label}, COALESCE(max(ordinal), 0) + 1
      FROM rounds WHERE competition_id = ${competitionId}
      RETURNING id
    `;
    const [stage] = await tx<{ id: string }[]>`
      INSERT INTO stages (organization_id, competition_id, round_id, kind, custom_label, timed, duration_seconds, advancement, created_by_account_id)
      VALUES (${organizationId}, ${competitionId}, ${round!.id}, ${definition.kind}, ${definition.customLabel}, ${definition.timed},
        ${definition.durationSeconds}, ${definition.advancement ? jsonValue(tx, definition.advancement) : null}, ${actorAccountId})
      RETURNING id
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "stage.created", subjectType: "stage", subjectId: stage!.id,
      details: { competitionId, kind: definition.kind, advancement: definition.advancement?.type ?? null }
    });
    const [row] = await tx<StageRow[]>`${SELECT_STAGE(tx)} WHERE s.id = ${stage!.id}`;
    return toStage(row!);
  });
}

async function lockStage(tx: Sql, organizationId: string, competitionId: string, stageId: string): Promise<StageRecord> {
  if (!isUuid(organizationId) || !isUuid(competitionId) || !isUuid(stageId)) throw new DomainError("stage_not_found");
  const [locked] = await tx`
    SELECT id FROM stages WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${stageId} FOR UPDATE
  `;
  if (!locked) throw new DomainError("stage_not_found");
  const [row] = await tx<StageRow[]>`${SELECT_STAGE(tx)} WHERE s.id = ${stageId}`;
  return toStage(row!);
}

/** Revisioned partial update. Decided stages and started rounds are immutable. */
export async function updateStage(
  organizationId: string,
  competitionId: string,
  stageId: string,
  actorAccountId: string,
  body: Record<string, unknown>,
  expectedRevision: number
): Promise<StageRecord> {
  return getSqlClient().begin(async tx => {
    await lockOpenEvent(tx, organizationId, competitionId);
    const current = await lockStage(tx, organizationId, competitionId, stageId);
    if (current.revision !== expectedRevision) throw new DomainError("stage_revision_conflict");
    if (current.decided) throw new DomainError("invalid_state_stage_decided");
    if (current.roundStatus === "completed" || current.roundStatus === "cancelled") throw new DomainError("invalid_state_stage_closed");
    const next = parseStageDefinition(body, current);
    await tx`UPDATE rounds SET label = ${next.label} WHERE organization_id = ${organizationId} AND id = ${current.roundId}`;
    await tx`
      UPDATE stages SET kind = ${next.kind}, custom_label = ${next.customLabel}, timed = ${next.timed},
        duration_seconds = ${next.durationSeconds}, advancement = ${next.advancement ? jsonValue(tx, next.advancement) : null},
        revision = revision + 1, updated_at = now()
      WHERE id = ${stageId}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "stage.updated", subjectType: "stage", subjectId: stageId,
      details: { revision: current.revision + 1, fields: Object.keys(body).sort() }
    });
    const [row] = await tx<StageRow[]>`${SELECT_STAGE(tx)} WHERE s.id = ${stageId}`;
    return toStage(row!);
  });
}

/**
 * Reorder all stages of an event. Stages are permuted within their existing ordinal
 * slots (rounds without a stage keep theirs); stages whose round has started may not move.
 */
export async function reorderStages(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  requestedOrder: unknown
): Promise<StageRecord[]> {
  await getSqlClient().begin(async tx => {
    await lockOpenEvent(tx, organizationId, competitionId);
    const rows = await tx<{ id: string; round_id: string; ordinal: number; status: string }[]>`
      SELECT s.id, s.round_id, r.ordinal, r.status::text AS status
      FROM stages s JOIN rounds r ON r.organization_id = s.organization_id AND r.id = s.round_id
      WHERE s.organization_id = ${organizationId} AND s.competition_id = ${competitionId}
      ORDER BY r.ordinal
      FOR UPDATE OF r
    `;
    const order = assertPermutation(rows.map(row => row.id), requestedOrder);
    const slots = rows.map(row => row.ordinal);
    const byId = new Map(rows.map(row => [row.id, row]));
    const assignments = order.map((id, index) => ({ row: byId.get(id)!, ordinal: slots[index]! }));
    if (assignments.some(({ row, ordinal }) => row.status !== "scheduled" && row.ordinal !== ordinal)) {
      throw new DomainError("invalid_state_stage_started");
    }
    const moving = assignments.filter(({ row, ordinal }) => row.ordinal !== ordinal);
    if (moving.length === 0) return;
    // Two phases so the (competition_id, ordinal) unique index never sees a duplicate.
    const roundIds = moving.map(({ row }) => row.round_id);
    await tx`UPDATE rounds SET ordinal = ordinal + 1000000 WHERE organization_id = ${organizationId} AND id = ANY(${roundIds}::uuid[])`;
    for (const { row, ordinal } of moving) {
      await tx`UPDATE rounds SET ordinal = ${ordinal} WHERE organization_id = ${organizationId} AND id = ${row.round_id}`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "stage.reordered", subjectType: "competition", subjectId: competitionId,
      details: { order }
    });
  });
  return listStages(organizationId, competitionId);
}

/** Final results of the stage's round for approved entries; best result per entry. */
async function loadStandings(tx: Sql, organizationId: string, roundId: string): Promise<Standing[]> {
  const rows = await tx<{ entry_id: string; rank: number | null; score: string | null }[]>`
    SELECT DISTINCT ON (r.entry_id) r.entry_id, r.rank, r.score
    FROM results r JOIN entries e ON e.organization_id = r.organization_id AND e.id = r.entry_id
    WHERE r.organization_id = ${organizationId} AND r.round_id = ${roundId} AND r.status = 'final' AND e.status = 'approved'
    ORDER BY r.entry_id, r.rank NULLS LAST, r.created_at DESC
  `;
  return rows.map(row => {
    const score = row.score === null ? null : Number(row.score);
    return { entryId: row.entry_id, rank: row.rank, score: score !== null && Number.isFinite(score) ? score : null };
  });
}

/**
 * Resolves bracket winners for a stage (provided by the optional LC-16 bracket module).
 * Returns null when the stage has no fully decided bracket.
 */
export type BracketWinnerResolver = (tx: Sql, organizationId: string, stageId: string) => Promise<string[] | null>;

interface DecisionRow {
  id: string; stage_id: string; contract: AdvancementContract; standings: Standing[]; advancing: string[];
  eliminated: string[]; tie_broken: boolean; tied_at_cut: string[]; decided_by_account_id: string; decided_at: Date;
}
const toDecision = (row: DecisionRow, replayed: boolean): AdvancementDecision => ({
  id: row.id, stageId: row.stage_id, contract: row.contract, standings: row.standings, advancing: row.advancing,
  eliminated: row.eliminated, tieBroken: row.tie_broken, tiedAtCut: row.tied_at_cut,
  decidedByAccountId: row.decided_by_account_id, decidedAt: row.decided_at, replayed
});

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Record the stage's single advancement decision from final results under its contract.
 * Idempotent per key: a retry with the same key returns the stored decision.
 */
export async function decideAdvancement(
  organizationId: string,
  competitionId: string,
  stageId: string,
  actorAccountId: string,
  input: { idempotencyKey: string; selection?: string[] },
  options: { bracketWinners?: BracketWinnerResolver } = {}
): Promise<AdvancementDecision> {
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new DomainError("invalid_idempotency_key");
  }
  return getSqlClient().begin(async tx => {
    const stage = await lockStage(tx, organizationId, competitionId, stageId);
    const [replay] = await tx<DecisionRow[]>`
      SELECT * FROM stage_advancements WHERE organization_id = ${organizationId} AND idempotency_key = ${input.idempotencyKey}
    `;
    if (replay) {
      if (replay.stage_id !== stageId) throw new DomainError("idempotency_key_conflict");
      return toDecision(replay, true);
    }
    if (stage.decided) throw new DomainError("stage_advancement_conflict");
    if (!stage.advancement) throw new DomainError("stage_advancement_contract_missing");
    const standings = await loadStandings(tx, organizationId, stage.roundId);
    let selection = input.selection;
    if (stage.advancement.type === "bracket") {
      const winners = options.bracketWinners ? await options.bracketWinners(tx, organizationId, stageId) : null;
      if (!winners) throw new DomainError("invalid_state_bracket_undecided");
      selection = winners;
      // Bracket sides may not have numeric results; every winner is a standing.
      for (const entryId of winners) {
        if (!standings.some(standing => standing.entryId === entryId)) standings.push({ entryId, rank: null, score: null });
      }
    } else if (standings.length === 0) {
      throw new DomainError("invalid_state_no_final_results");
    }
    const outcome = computeAdvancement(stage.advancement, standings, selection);
    const [row] = await tx<DecisionRow[]>`
      INSERT INTO stage_advancements (organization_id, competition_id, stage_id, idempotency_key, contract, standings,
        advancing, eliminated, tie_broken, tied_at_cut, decided_by_account_id)
      VALUES (${organizationId}, ${competitionId}, ${stageId}, ${input.idempotencyKey}, ${jsonValue(tx, stage.advancement)},
        ${jsonValue(tx, standings)}, ${jsonValue(tx, outcome.advancing)}, ${jsonValue(tx, outcome.eliminated)},
        ${outcome.tieBroken}, ${jsonValue(tx, outcome.tiedAtCut)}, ${actorAccountId})
      RETURNING *
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "stage.advancement_decided", subjectType: "stage", subjectId: stageId,
      details: {
        decisionId: row!.id, contract: stage.advancement.type, advancing: outcome.advancing.length,
        eliminated: outcome.eliminated.length, tieBroken: outcome.tieBroken
      }
    });
    return toDecision(row!, false);
  });
}

export async function getAdvancement(organizationId: string, competitionId: string, stageId: string): Promise<AdvancementDecision | null> {
  if (!isUuid(organizationId) || !isUuid(competitionId) || !isUuid(stageId)) return null;
  const [row] = await getSqlClient()<DecisionRow[]>`
    SELECT * FROM stage_advancements
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND stage_id = ${stageId}
  `;
  return row ? toDecision(row, false) : null;
}
