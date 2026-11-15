import { randomUUID } from "node:crypto";
import { DomainError, isBoundedText, isUuid } from "@live-competition-engine/domain";
import {
  generateSingleElimination,
  planMatchAction,
  type MatchAction,
  type MatchStatus
} from "@live-competition-engine/domain/brackets";
import { recordAudit, type Sql } from "./audit.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { IDEMPOTENCY_KEY, type BracketWinnerResolver } from "./stages.ts";

/**
 * LC-16 optional head-to-head and bracket model, gated by the `brackets` feature.
 * Teams are generic groups/crews and are not gated. Nothing outside this module
 * requires brackets; LC-15 stages use `bracketWinnersForStage` only when a stage's
 * contract is `bracket`.
 */
export interface SideInput {
  entryId?: string;
  teamId?: string;
  seed?: number;
}

export interface MatchSideView {
  slot: number;
  entryId: string | null;
  teamId: string | null;
  seed: number | null;
  displayName: string;
}

export interface MatchView {
  id: string;
  bracketId: string | null;
  round: number | null;
  position: number | null;
  status: MatchStatus;
  bye: boolean;
  expectedSides: number;
  winnerSlot: number | null;
  nextMatchId: string | null;
  nextSlot: number | null;
  revision: number;
  voidReason: string | null;
  sides: MatchSideView[];
}

export interface BracketView {
  id: string;
  competitionId: string;
  stageId: string | null;
  format: "single_elimination";
  sideKind: "entry" | "team";
  size: number;
  status: "active" | "completed";
  rounds: number;
  matches: MatchView[];
  replayed?: boolean;
}

/** Event must exist in this tenant (else 404, never a cross-tenant flag lookup), then the flag must be on. */
async function gate(organizationId: string, competitionId: string): Promise<void> {
  if (!isUuid(organizationId) || !isUuid(competitionId)) throw new DomainError("event_not_found");
  const [event] = await getSqlClient()`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
  if (!event) throw new DomainError("event_not_found");
  await requireEnabledFeature("brackets", { organizationId, eventId: competitionId });
}

async function lockOpenEvent(tx: Sql, organizationId: string, competitionId: string): Promise<void> {
  if (!isUuid(organizationId) || !isUuid(competitionId)) throw new DomainError("event_not_found");
  const [event] = await tx<{ status: string }[]>`
    SELECT status FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId} FOR UPDATE
  `;
  if (!event) throw new DomainError("event_not_found");
  if (event.status === "completed" || event.status === "cancelled") throw new DomainError("invalid_state_event_closed");
}

// ---------------------------------------------------------------- teams

export async function createTeam(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: { name: unknown; participantIds: unknown }
): Promise<{ id: string; name: string; participantIds: string[] }> {
  if (!isBoundedText(input.name, 200, 1) || !input.name.trim()) throw new DomainError("invalid_team_name");
  const { participantIds } = input;
  if (!Array.isArray(participantIds) || participantIds.length < 1 || participantIds.length > 50 ||
    !participantIds.every(isUuid) || new Set(participantIds).size !== participantIds.length) {
    throw new DomainError("invalid_team_members");
  }
  const name = input.name;
  try {
    return await getSqlClient().begin(async tx => {
      await lockOpenEvent(tx, organizationId, competitionId);
      const found = await tx`SELECT id FROM participants WHERE organization_id = ${organizationId} AND id = ANY(${participantIds}::uuid[])`;
      if (found.length !== participantIds.length) throw new DomainError("participant_not_found");
      const [team] = await tx<{ id: string }[]>`
        INSERT INTO teams (organization_id, competition_id, name, created_by_account_id)
        VALUES (${organizationId}, ${competitionId}, ${name}, ${actorAccountId}) RETURNING id
      `;
      for (const participantId of participantIds) {
        await tx`INSERT INTO team_members (organization_id, competition_id, team_id, participant_id)
          VALUES (${organizationId}, ${competitionId}, ${team!.id}, ${participantId})`;
      }
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "team.created", subjectType: "team", subjectId: team!.id,
        details: { competitionId, members: participantIds.length }
      });
      return { id: team!.id, name, participantIds: participantIds as string[] };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new DomainError((error as { constraint_name?: string }).constraint_name === "teams_competition_name_uniq"
        ? "team_name_conflict" : "team_member_conflict");
    }
    throw error;
  }
}

export async function listTeams(organizationId: string, competitionId: string) {
  if (!isUuid(organizationId) || !isUuid(competitionId)) return [];
  const rows = await getSqlClient()<{ id: string; name: string; participant_ids: string[] }[]>`
    SELECT t.id, t.name, COALESCE(array_agg(m.participant_id ORDER BY m.participant_id) FILTER (WHERE m.participant_id IS NOT NULL), '{}') AS participant_ids
    FROM teams t LEFT JOIN team_members m ON m.team_id = t.id
    WHERE t.organization_id = ${organizationId} AND t.competition_id = ${competitionId}
    GROUP BY t.id, t.name ORDER BY lower(t.name), t.id
  `;
  return rows.map(row => ({ id: row.id, name: row.name, participantIds: row.participant_ids }));
}

// ---------------------------------------------------------------- sides

interface ResolvedSide {
  key: string;
  kind: "entry" | "team";
  seed: number | null;
}

/** Validate that every side is an approved entry or a team of this event; one kind only. */
async function resolveSides(tx: Sql, organizationId: string, competitionId: string, sides: unknown, requireSeeds: boolean): Promise<ResolvedSide[]> {
  if (!Array.isArray(sides) || sides.length < 2 || sides.length > 256) throw new DomainError("invalid_match_sides");
  const resolved: ResolvedSide[] = sides.map((raw: SideInput) => {
    if (!raw || typeof raw !== "object") throw new DomainError("invalid_match_sides");
    const hasEntry = raw.entryId !== undefined, hasTeam = raw.teamId !== undefined;
    if (hasEntry === hasTeam || !isUuid(hasEntry ? raw.entryId : raw.teamId)) throw new DomainError("invalid_match_sides");
    if (raw.seed !== undefined && (!Number.isInteger(raw.seed) || raw.seed < 1)) throw new DomainError("invalid_bracket_seeds");
    if (requireSeeds && raw.seed === undefined) throw new DomainError("invalid_bracket_seeds");
    return { key: (hasEntry ? raw.entryId! : raw.teamId!).toLowerCase(), kind: hasEntry ? "entry" : "team", seed: raw.seed ?? null };
  });
  const kind = resolved[0]!.kind;
  if (resolved.some(side => side.kind !== kind)) throw new DomainError("invalid_match_sides_mixed");
  const keys = resolved.map(side => side.key);
  if (new Set(keys).size !== keys.length) throw new DomainError("invalid_match_sides");
  const found = kind === "entry"
    ? await tx`SELECT id FROM entries WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
        AND status = 'approved' AND id = ANY(${keys}::uuid[])`
    : await tx`SELECT id FROM teams WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
        AND id = ANY(${keys}::uuid[])`;
  if (found.length !== keys.length) throw new DomainError(kind === "entry" ? "entry_not_found" : "team_not_found");
  return resolved;
}

const sideColumns = (kind: "entry" | "team", key: string) => ({
  entry_id: kind === "entry" ? key : null,
  team_id: kind === "team" ? key : null
});

// ---------------------------------------------------------------- brackets

/**
 * Create a seeded single-elimination bracket (idempotent per key). Bye matches are
 * stored decided with their side already placed in round 2.
 */
export async function createBracket(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: { stageId?: unknown; sides: unknown; idempotencyKey: unknown }
): Promise<BracketView> {
  if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new DomainError("invalid_idempotency_key");
  if (input.stageId !== undefined && input.stageId !== null && !isUuid(input.stageId)) throw new DomainError("stage_not_found");
  await gate(organizationId, competitionId);
  const idempotencyKey = input.idempotencyKey;
  const bracketId = await getSqlClient().begin(async tx => {
    await lockOpenEvent(tx, organizationId, competitionId);
    const [existing] = await tx<{ id: string; competition_id: string }[]>`
      SELECT id, competition_id FROM brackets WHERE organization_id = ${organizationId} AND idempotency_key = ${idempotencyKey}
    `;
    if (existing) {
      if (existing.competition_id !== competitionId) throw new DomainError("idempotency_key_conflict");
      return { id: existing.id, replayed: true };
    }
    const stageId = (input.stageId as string | undefined) ?? null;
    if (stageId) {
      const [stage] = await tx`SELECT 1 FROM stages WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${stageId}`;
      if (!stage) throw new DomainError("stage_not_found");
      const [taken] = await tx`SELECT 1 FROM brackets WHERE stage_id = ${stageId}`;
      if (taken) throw new DomainError("bracket_stage_conflict");
    }
    const sides = await resolveSides(tx, organizationId, competitionId, input.sides, true);
    const plan = generateSingleElimination(sides.map(side => ({ key: side.key, seed: side.seed! })));
    const kind = sides[0]!.kind;
    const [bracket] = await tx<{ id: string }[]>`
      INSERT INTO brackets (organization_id, competition_id, stage_id, format, side_kind, size, idempotency_key, created_by_account_id)
      VALUES (${organizationId}, ${competitionId}, ${stageId}, 'single_elimination', ${kind}, ${plan.size}, ${idempotencyKey}, ${actorAccountId})
      RETURNING id
    `;
    const ids = new Map(plan.matches.map(match => [`${match.round}:${match.position}`, randomUUID()]));
    for (const match of plan.matches) {
      const nextId = match.next ? ids.get(`${match.next.round}:${match.next.position}`)! : null;
      await tx`
        INSERT INTO matches (id, organization_id, competition_id, bracket_id, round_number, position, status, is_bye,
          winner_slot, next_match_id, next_slot, decided_at)
        VALUES (${ids.get(`${match.round}:${match.position}`)!}, ${organizationId}, ${competitionId}, ${bracket!.id},
          ${match.round}, ${match.position}, ${match.status}, ${match.bye}, ${match.winnerSlot}, ${nextId},
          ${match.next?.slot ?? null}, ${match.bye ? tx`now()` : null})
      `;
    }
    for (const match of plan.matches) {
      for (const side of match.sides) {
        const columns = sideColumns(kind, side.key);
        await tx`
          INSERT INTO match_sides (organization_id, competition_id, match_id, slot, entry_id, team_id, seed)
          VALUES (${organizationId}, ${competitionId}, ${ids.get(`${match.round}:${match.position}`)!}, ${side.slot},
            ${columns.entry_id}, ${columns.team_id}, ${side.seed})
        `;
      }
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "bracket.created", subjectType: "bracket", subjectId: bracket!.id,
      details: { competitionId, stageId, size: plan.size, sides: sides.length, sideKind: kind, byes: plan.matches.filter(m => m.bye).length }
    });
    return { id: bracket!.id, replayed: false };
  });
  const view = await readBracket(getSqlClient(), organizationId, competitionId, bracketId.id);
  return { ...view!, replayed: bracketId.replayed };
}

interface MatchRow {
  id: string; bracket_id: string | null; round_number: number | null; position: number | null; status: MatchStatus;
  is_bye: boolean; expected_sides: number; winner_slot: number | null; next_match_id: string | null; next_slot: number | null;
  revision: number; void_reason: string | null;
}

async function readMatches(sql: Sql, organizationId: string, competitionId: string, where: { bracketId?: string; matchId?: string }): Promise<MatchView[]> {
  const rows = await sql<MatchRow[]>`
    SELECT id, bracket_id, round_number, position, status, is_bye, expected_sides, winner_slot, next_match_id, next_slot, revision, void_reason
    FROM matches WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      ${where.bracketId ? sql`AND bracket_id = ${where.bracketId}` : sql``}
      ${where.matchId ? sql`AND id = ${where.matchId}` : sql``}
    ORDER BY round_number NULLS LAST, position, created_at, id
  `;
  if (rows.length === 0) return [];
  const sides = await sql<{ match_id: string; slot: number; entry_id: string | null; team_id: string | null; seed: number | null; display_name: string }[]>`
    SELECT s.match_id, s.slot, s.entry_id, s.team_id, s.seed, COALESCE(p.display_name, t.name) AS display_name
    FROM match_sides s
    LEFT JOIN entries e ON e.organization_id = s.organization_id AND e.id = s.entry_id
    LEFT JOIN participants p ON p.organization_id = e.organization_id AND p.id = e.participant_id
    LEFT JOIN teams t ON t.competition_id = s.competition_id AND t.id = s.team_id
    WHERE s.organization_id = ${organizationId} AND s.match_id = ANY(${rows.map(row => row.id)}::uuid[])
    ORDER BY s.match_id, s.slot
  `;
  return rows.map(row => ({
    id: row.id, bracketId: row.bracket_id, round: row.round_number, position: row.position, status: row.status, bye: row.is_bye,
    expectedSides: row.expected_sides, winnerSlot: row.winner_slot, nextMatchId: row.next_match_id, nextSlot: row.next_slot,
    revision: row.revision, voidReason: row.void_reason,
    sides: sides.filter(side => side.match_id === row.id).map(side => ({
      slot: side.slot, entryId: side.entry_id, teamId: side.team_id, seed: side.seed, displayName: side.display_name
    }))
  }));
}

async function readBracket(sql: Sql, organizationId: string, competitionId: string, bracketId: string): Promise<BracketView | null> {
  if (!isUuid(organizationId) || !isUuid(competitionId) || !isUuid(bracketId)) return null;
  const [row] = await sql<{ id: string; competition_id: string; stage_id: string | null; format: "single_elimination"; side_kind: "entry" | "team"; size: number; status: "active" | "completed" }[]>`
    SELECT id, competition_id, stage_id, format, side_kind, size, status FROM brackets
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${bracketId}
  `;
  if (!row) return null;
  return {
    id: row.id, competitionId: row.competition_id, stageId: row.stage_id, format: row.format, sideKind: row.side_kind,
    size: row.size, status: row.status, rounds: Math.log2(row.size),
    matches: await readMatches(sql, organizationId, competitionId, { bracketId })
  };
}

/** Operator read (event.manage at the HTTP layer). */
export async function getBracket(organizationId: string, competitionId: string, bracketId: string): Promise<BracketView | null> {
  await gate(organizationId, competitionId);
  return readBracket(getSqlClient(), organizationId, competitionId, bracketId);
}

export async function listBrackets(organizationId: string, competitionId: string) {
  await gate(organizationId, competitionId);
  return getSqlClient()<{ id: string; stage_id: string | null; size: number; status: string; side_kind: string }[]>`
    SELECT id, stage_id, size, status, side_kind FROM brackets
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} ORDER BY created_at, id
  `;
}

/** Public read: only for public, non-draft events. */
export async function getPublicBracket(organizationId: string, competitionId: string, bracketId: string): Promise<BracketView | null> {
  if (!isUuid(organizationId) || !isUuid(competitionId) || !isUuid(bracketId)) return null;
  const sql = getSqlClient();
  const [event] = await sql`
    SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}
      AND visibility = 'public' AND status <> 'draft'
  `;
  if (!event) return null;
  await gate(organizationId, competitionId);
  return readBracket(sql, organizationId, competitionId, bracketId);
}

// ---------------------------------------------------------------- matches

/** Standalone (non-bracket) match between 2..64 sides. */
export async function createMatch(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: { sides: unknown }
): Promise<MatchView> {
  await gate(organizationId, competitionId);
  const id = await getSqlClient().begin(async tx => {
    await lockOpenEvent(tx, organizationId, competitionId);
    if (Array.isArray(input.sides) && input.sides.length > 64) throw new DomainError("invalid_match_sides");
    const sides = await resolveSides(tx, organizationId, competitionId, input.sides, false);
    const [match] = await tx<{ id: string }[]>`
      INSERT INTO matches (organization_id, competition_id, expected_sides)
      VALUES (${organizationId}, ${competitionId}, ${sides.length}) RETURNING id
    `;
    for (const [slot, side] of sides.entries()) {
      const columns = sideColumns(side.kind, side.key);
      await tx`
        INSERT INTO match_sides (organization_id, competition_id, match_id, slot, entry_id, team_id, seed)
        VALUES (${organizationId}, ${competitionId}, ${match!.id}, ${slot}, ${columns.entry_id}, ${columns.team_id}, ${side.seed})
      `;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "match.created", subjectType: "match", subjectId: match!.id,
      details: { competitionId, sides: sides.length }
    });
    return match!.id;
  });
  return (await readMatches(getSqlClient(), organizationId, competitionId, { matchId: id }))[0]!;
}

/**
 * Apply a lifecycle action under a row lock and If-Match revision. Deciding a bracket
 * match places the winner into its next match slot; deciding the final completes the bracket.
 */
export async function actOnMatch(
  organizationId: string,
  competitionId: string,
  matchId: string,
  actorAccountId: string,
  input: { action: MatchAction; winnerSlot?: number | null; reason?: string | null },
  expectedRevision: number
): Promise<MatchView> {
  if (!isUuid(organizationId) || !isUuid(competitionId) || !isUuid(matchId)) throw new DomainError("match_not_found");
  await gate(organizationId, competitionId);
  await getSqlClient().begin(async tx => {
    const [match] = await tx<MatchRow[]>`
      SELECT id, bracket_id, round_number, position, status, is_bye, expected_sides, winner_slot, next_match_id, next_slot, revision, void_reason
      FROM matches WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${matchId}
      FOR UPDATE
    `;
    if (!match) throw new DomainError("match_not_found");
    if (match.revision !== expectedRevision) throw new DomainError("match_revision_conflict");
    const sides = await tx<{ slot: number; entry_id: string | null; team_id: string | null; seed: number | null }[]>`
      SELECT slot, entry_id, team_id, seed FROM match_sides WHERE match_id = ${matchId} ORDER BY slot
    `;
    const target = planMatchAction(match.status, input.action, {
      filledSlots: sides.map(side => side.slot), expectedSides: match.expected_sides,
      winnerSlot: input.winnerSlot ?? null, reason: input.reason ?? null
    });
    await tx`
      UPDATE matches SET status = ${target}, revision = revision + 1,
        winner_slot = ${target === "decided" ? input.winnerSlot! : null},
        void_reason = ${target === "void" ? input.reason! : null},
        decided_by_account_id = ${target === "decided" || target === "void" ? actorAccountId : null},
        decided_at = ${target === "decided" || target === "void" ? tx`now()` : null}
      WHERE id = ${matchId}
    `;
    let advancedTo: string | null = null;
    if (target === "decided" && match.next_match_id) {
      const winner = sides.find(side => side.slot === input.winnerSlot)!;
      const [next] = await tx<{ status: string }[]>`SELECT status FROM matches WHERE id = ${match.next_match_id} FOR UPDATE`;
      if (!next || next.status !== "scheduled") throw new DomainError("invalid_state_next_match_started");
      const inserted = await tx`
        INSERT INTO match_sides (organization_id, competition_id, match_id, slot, entry_id, team_id, seed)
        VALUES (${organizationId}, ${competitionId}, ${match.next_match_id}, ${match.next_slot}, ${winner.entry_id}, ${winner.team_id}, ${winner.seed})
        ON CONFLICT DO NOTHING RETURNING slot
      `;
      if (inserted.length !== 1) throw new DomainError("match_advancement_conflict");
      advancedTo = match.next_match_id;
    } else if (target === "decided" && match.bracket_id) {
      await tx`UPDATE brackets SET status = 'completed' WHERE id = ${match.bracket_id}`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId,
      action: target === "live" ? "match.started" : target === "decided" ? "match.decided" : "match.voided",
      subjectType: "match", subjectId: matchId,
      details: {
        competitionId, bracketId: match.bracket_id, revision: match.revision + 1,
        ...(target === "decided" ? { winnerSlot: input.winnerSlot, advancedTo } : {}),
        ...(target === "void" ? { reason: input.reason } : {})
      }
    });
  });
  return (await readMatches(getSqlClient(), organizationId, competitionId, { matchId }))[0]!;
}

/**
 * BracketWinnerResolver for LC-15 stages with a `bracket` contract: the champion of
 * the stage's completed bracket (entry or team id), or null when not completed.
 */
export const bracketWinnersForStage: BracketWinnerResolver = async (tx, organizationId, stageId) => {
  const [row] = await tx<{ entry_id: string | null; team_id: string | null }[]>`
    SELECT s.entry_id, s.team_id
    FROM brackets b
    JOIN matches m ON m.bracket_id = b.id AND m.next_match_id IS NULL AND m.status = 'decided'
    JOIN match_sides s ON s.match_id = m.id AND s.slot = m.winner_slot
    WHERE b.organization_id = ${organizationId} AND b.stage_id = ${stageId} AND b.status = 'completed'
  `;
  return row ? [(row.entry_id ?? row.team_id)!] : null;
};
