import type postgres from "postgres";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import { validateReason } from "@live-competition-engine/domain/applications";
import {
  assertCorrection, assertCorrectionDecision, computeStandings, parseRubric, sameValues, validateScoreValues,
  type CorrectionStatus, type Rubric, type ScoreValues, type Standing
} from "@live-competition-engine/domain/scoring";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";
import { assertPerformanceAccess, resolveJudge } from "./judges.ts";

/**
 * LC-20 scoring storage: versioned rubrics, judge score sheets (draft → submitted, then
 * immutable), producer-approved corrections that supersede a sheet, and standings computed
 * with the pure `computeStandings`.
 */

function ids(...values: string[]): void {
  if (!values.every(isUuid)) throw new DomainError("not_found");
}

export interface RubricView { id: string; version: number; status: "draft" | "active" | "retired"; definition: Rubric; createdAt: Date; activatedAt: Date | null; }
interface RubricRow { id: string; version: number; status: RubricView["status"]; definition: Rubric; created_at: Date; activated_at: Date | null; }
const toRubric = (r: RubricRow): RubricView => ({ id: r.id, version: r.version, status: r.status, definition: r.definition, createdAt: r.created_at, activatedAt: r.activated_at });

export async function createRubric(organizationId: string, competitionId: string, actorAccountId: string, definition: unknown): Promise<RubricView> {
  ids(organizationId, competitionId, actorAccountId);
  const rubric = parseRubric(definition);
  return getSqlClient().begin(async tx => {
    const [competition] = await tx`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
    if (!competition) throw new DomainError("competition_not_found");
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`rubric:${competitionId}`}, 0))`;
    const [row] = await tx<RubricRow[]>`
      INSERT INTO scoring_rubrics (organization_id, competition_id, version, definition, created_by_account_id)
      VALUES (${organizationId}, ${competitionId},
        (SELECT coalesce(max(version), 0) + 1 FROM scoring_rubrics WHERE competition_id = ${competitionId}),
        ${tx.json(rubric as unknown as postgres.JSONValue)}, ${actorAccountId})
      RETURNING id, version, status, definition, created_at, activated_at
    `;
    await recordAudit(tx, { organizationId, actorAccountId, action: "rubric.created", subjectType: "scoring_rubric", subjectId: row!.id, details: { competitionId, version: row!.version } });
    return toRubric(row!);
  });
}

export async function listRubrics(organizationId: string, competitionId: string): Promise<RubricView[]> {
  ids(organizationId, competitionId);
  const rows = await getSqlClient()<RubricRow[]>`SELECT id, version, status, definition, created_at, activated_at FROM scoring_rubrics
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} ORDER BY version DESC`;
  return rows.map(toRubric);
}

async function activeRubric(sql: Sql, organizationId: string, competitionId: string): Promise<RubricView> {
  const [row] = await sql<RubricRow[]>`SELECT id, version, status, definition, created_at, activated_at FROM scoring_rubrics
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND status = 'active'`;
  if (!row) throw new DomainError("rubric_not_found");
  return toRubric(row);
}

export async function getActiveRubric(organizationId: string, competitionId: string): Promise<RubricView> {
  ids(organizationId, competitionId);
  return activeRubric(getSqlClient(), organizationId, competitionId);
}

/**
 * Activate a draft rubric version (retiring the current one). Refused once submitted scores exist
 * under the current active version: changing the rules mid-scoring would silently re-rank.
 */
export async function activateRubric(organizationId: string, competitionId: string, actorAccountId: string, rubricId: string): Promise<RubricView> {
  ids(organizationId, competitionId, actorAccountId, rubricId);
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`rubric:${competitionId}`}, 0))`;
    const [target] = await tx<RubricRow[]>`SELECT id, version, status, definition, created_at, activated_at FROM scoring_rubrics
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${rubricId} FOR UPDATE`;
    if (!target) throw new DomainError("rubric_not_found");
    if (target.status === "active") return toRubric(target);
    if (target.status !== "draft") throw new DomainError("invalid_state_rubric_retired");
    const [current] = await tx<{ id: string }[]>`SELECT id FROM scoring_rubrics WHERE competition_id = ${competitionId} AND status = 'active' FOR UPDATE`;
    if (current) {
      const [scored] = await tx`SELECT 1 FROM score_sheets WHERE organization_id = ${organizationId} AND rubric_id = ${current.id} AND status <> 'draft' LIMIT 1`;
      if (scored) throw new DomainError("invalid_state_scores_exist");
      await tx`UPDATE scoring_rubrics SET status = 'retired' WHERE id = ${current.id}`;
    }
    const [row] = await tx<RubricRow[]>`UPDATE scoring_rubrics SET status = 'active', activated_at = now(), activated_by_account_id = ${actorAccountId}
      WHERE id = ${rubricId} RETURNING id, version, status, definition, created_at, activated_at`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "rubric.activated", subjectType: "scoring_rubric", subjectId: rubricId,
      details: { competitionId, version: row!.version, retired: current?.id ?? null } });
    return toRubric(row!);
  });
}

export interface SheetView {
  id: string; performanceId: string; roundId: string; rubricId: string; values: ScoreValues; status: "draft" | "submitted" | "superseded";
  revision: number; submittedAt: Date | null; supersedesSheetId: string | null;
}
interface SheetRow {
  id: string; organization_id: string; competition_id: string; round_id: string; performance_id: string; entry_id: string; judge_id: string;
  rubric_id: string; score_values: ScoreValues; status: SheetView["status"]; revision: number; author_account_id: string;
  submitted_at: Date | null; supersedes_sheet_id: string | null;
}
const toSheet = (r: SheetRow): SheetView => ({
  id: r.id, performanceId: r.performance_id, roundId: r.round_id, rubricId: r.rubric_id, values: r.score_values, status: r.status,
  revision: r.revision, submittedAt: r.submitted_at, supersedesSheetId: r.supersedes_sheet_id
});

export async function getOwnScoreSheet(
  organizationId: string, competitionId: string, accountId: string, roundId: string, performanceId: string
): Promise<{ rubric: RubricView; sheet: SheetView | null }> {
  ids(organizationId, competitionId, accountId, roundId, performanceId);
  const sql = getSqlClient();
  const access = await assertPerformanceAccess(sql, organizationId, competitionId, accountId, roundId, performanceId, "view");
  const rubric = await activeRubric(sql, organizationId, competitionId);
  const [row] = await sql<SheetRow[]>`SELECT * FROM score_sheets WHERE organization_id = ${organizationId} AND performance_id = ${performanceId}
    AND judge_id = ${access.judgeId} AND status IN ('draft','submitted')`;
  return { rubric, sheet: row ? toSheet(row) : null };
}

/**
 * Save a draft or submit a judge's sheet for one performance. The judge must be verified, on the
 * round's panel and not recused. Submitted sheets are immutable: re-submitting identical values is an
 * idempotent no-op, anything else is 409 `score_immutable_conflict` (use a correction instead).
 */
export async function saveScoreSheet(
  organizationId: string, competitionId: string, accountId: string, roundId: string, performanceId: string,
  input: { values: unknown; submit: unknown; expectedRevision?: unknown }
): Promise<{ sheet: SheetView; changed: boolean }> {
  ids(organizationId, competitionId, accountId, roundId, performanceId);
  if (typeof input.submit !== "boolean") throw new DomainError("invalid_submit_flag");
  const submit = input.submit;
  try {
    return await getSqlClient().begin(async tx => {
      const access = await assertPerformanceAccess(tx, organizationId, competitionId, accountId, roundId, performanceId, "score");
      if (access.roundStatus === "cancelled" || access.performanceStatus === "skipped") throw new DomainError("invalid_state_not_scorable");
      const rubric = await activeRubric(tx, organizationId, competitionId);
      const values = validateScoreValues(rubric.definition, input.values, { complete: submit });
      const [existing] = await tx<SheetRow[]>`SELECT * FROM score_sheets WHERE organization_id = ${organizationId} AND performance_id = ${performanceId}
        AND judge_id = ${access.judgeId} AND status IN ('draft','submitted') FOR UPDATE`;
      if (existing?.status === "submitted") {
        if (submit && existing.rubric_id === rubric.id && sameValues(existing.score_values, values)) return { sheet: toSheet(existing), changed: false };
        throw new DomainError("score_immutable_conflict");
      }
      if (existing && input.expectedRevision !== existing.revision) throw new DomainError("score_revision_conflict");
      if (!existing && input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new DomainError("score_revision_conflict");
      const status = submit ? "submitted" : "draft";
      const submittedAt = submit ? new Date() : null;
      const [row] = existing
        ? await tx<SheetRow[]>`UPDATE score_sheets SET score_values = ${tx.json(values)}, rubric_id = ${rubric.id}, status = ${status},
            submitted_at = ${submittedAt}, revision = revision + 1, updated_at = now() WHERE id = ${existing.id} RETURNING *`
        : await tx<SheetRow[]>`INSERT INTO score_sheets (organization_id, competition_id, round_id, performance_id, entry_id, judge_id, rubric_id,
            score_values, status, author_account_id, submitted_at)
          VALUES (${organizationId}, ${competitionId}, ${roundId}, ${performanceId}, ${access.entryId}, ${access.judgeId}, ${rubric.id},
            ${tx.json(values)}, ${status}, ${accountId}, ${submittedAt}) RETURNING *`;
      if (submit) {
        await recordAudit(tx, {
          organizationId, actorAccountId: accountId, action: "score.submitted", subjectType: "score_sheet", subjectId: row!.id,
          details: { competitionId, roundId, performanceId, judgeId: access.judgeId, rubricVersion: rubric.version, values }
        });
      }
      return { sheet: toSheet(row!), changed: true };
    });
  } catch (error) {
    if ((error as { constraint_name?: string }).constraint_name === "score_sheets_one_current_uniq") throw new DomainError("score_revision_conflict");
    throw error;
  }
}

export interface CorrectionView {
  id: string; sheetId: string; status: CorrectionStatus; proposedValues: ScoreValues; originalValues: ScoreValues; reason: string;
  requestedByAccountId: string; decidedByAccountId: string | null; decidedAt: Date | null; decisionReason: string | null;
  replacementSheetId: string | null; revision: number; createdAt: Date; performanceId: string; judgeId: string;
}
interface CorrectionRow {
  id: string; sheet_id: string; status: CorrectionStatus; proposed_values: ScoreValues; score_values: ScoreValues; reason: string;
  requested_by_account_id: string; decided_by_account_id: string | null; decided_at: Date | null; decision_reason: string | null;
  replacement_sheet_id: string | null; revision: number; created_at: Date; performance_id: string; judge_id: string;
}
const toCorrection = (r: CorrectionRow): CorrectionView => ({
  id: r.id, sheetId: r.sheet_id, status: r.status, proposedValues: r.proposed_values, originalValues: r.score_values, reason: r.reason,
  requestedByAccountId: r.requested_by_account_id, decidedByAccountId: r.decided_by_account_id, decidedAt: r.decided_at,
  decisionReason: r.decision_reason, replacementSheetId: r.replacement_sheet_id, revision: r.revision, createdAt: r.created_at,
  performanceId: r.performance_id, judgeId: r.judge_id
});
const correctionSelect = (sql: Sql) => sql`
  SELECT c.*, s.score_values, s.performance_id, s.judge_id FROM score_corrections c
  JOIN score_sheets s ON s.organization_id = c.organization_id AND s.id = c.sheet_id`;

/** The judge who submitted a sheet asks for a correction; it takes effect only after producer approval. */
export async function requestScoreCorrection(
  organizationId: string, competitionId: string, accountId: string, input: { sheetId: unknown; values: unknown; reason: unknown }
): Promise<CorrectionView> {
  ids(organizationId, competitionId, accountId);
  if (!isUuid(input.sheetId)) throw new DomainError("score_sheet_not_found");
  const sheetId = input.sheetId;
  const reason = validateReason(input.reason, true)!;
  try {
    return await getSqlClient().begin(async tx => {
      const judge = await resolveJudge(tx, organizationId, competitionId, accountId);
      const [sheet] = await tx<(SheetRow & { definition: Rubric })[]>`
        SELECT s.*, r.definition FROM score_sheets s JOIN scoring_rubrics r ON r.organization_id = s.organization_id AND r.id = s.rubric_id
        WHERE s.organization_id = ${organizationId} AND s.competition_id = ${competitionId} AND s.id = ${sheetId} AND s.judge_id = ${judge.judgeId}
        FOR UPDATE OF s`;
      if (!sheet) throw new DomainError("score_sheet_not_found");
      if (sheet.status !== "submitted") throw new DomainError("invalid_state_sheet_not_submitted");
      const values = validateScoreValues(sheet.definition, input.values, { complete: true });
      assertCorrection(sheet.score_values, values);
      const [row] = await tx<{ id: string }[]>`INSERT INTO score_corrections (organization_id, competition_id, sheet_id, requested_by_account_id, proposed_values, reason)
        VALUES (${organizationId}, ${competitionId}, ${sheetId}, ${accountId}, ${tx.json(values)}, ${reason}) RETURNING id`;
      await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "score.correction_requested", subjectType: "score_sheet", subjectId: sheetId,
        details: { competitionId, correctionId: row!.id, from: sheet.score_values, to: values, reason } });
      const [view] = await tx<CorrectionRow[]>`${correctionSelect(tx)} WHERE c.id = ${row!.id}`;
      return toCorrection(view!);
    });
  } catch (error) {
    if ((error as { constraint_name?: string }).constraint_name === "score_corrections_one_pending_uniq") throw new DomainError("correction_pending_conflict");
    throw error;
  }
}

export async function listCorrections(organizationId: string, competitionId: string, options: { status?: string } = {}): Promise<CorrectionView[]> {
  ids(organizationId, competitionId);
  if (options.status !== undefined && !["pending", "approved", "rejected"].includes(options.status)) throw new DomainError("invalid_status_filter");
  const sql = getSqlClient();
  const rows = await sql<CorrectionRow[]>`${correctionSelect(sql)} WHERE c.organization_id = ${organizationId} AND c.competition_id = ${competitionId}
    ${options.status ? sql`AND c.status = ${options.status}` : sql``} ORDER BY c.created_at DESC, c.id LIMIT 500`;
  return rows.map(toCorrection);
}

/**
 * Producer decision on a correction. Approval supersedes the original sheet and inserts a new
 * submitted sheet linked to it (both kept). The requester can never approve their own correction.
 */
export async function decideCorrection(
  organizationId: string, competitionId: string, actorAccountId: string, correctionId: string,
  input: { decision: unknown; reason?: unknown; expectedRevision: unknown }
): Promise<CorrectionView> {
  ids(organizationId, competitionId, actorAccountId, correctionId);
  if (input.decision !== "approved" && input.decision !== "rejected") throw new DomainError("invalid_correction_decision");
  const decision = input.decision;
  const reason = validateReason(input.reason, decision === "rejected");
  return getSqlClient().begin(async tx => {
    const [correction] = await tx<(CorrectionRow & { competition_id: string })[]>`SELECT * FROM score_corrections
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${correctionId} FOR UPDATE`;
    if (!correction) throw new DomainError("correction_not_found");
    if (correction.revision !== input.expectedRevision) throw new DomainError("correction_revision_conflict");
    assertCorrectionDecision(correction.status, correction.requested_by_account_id, actorAccountId);
    let replacement: string | null = null;
    if (decision === "approved") {
      const [original] = await tx<SheetRow[]>`SELECT * FROM score_sheets WHERE organization_id = ${organizationId} AND id = ${correction.sheet_id} FOR UPDATE`;
      if (!original || original.status !== "submitted") throw new DomainError("invalid_state_sheet_not_submitted");
      await tx`UPDATE score_sheets SET status = 'superseded', updated_at = now() WHERE id = ${original.id}`;
      const [row] = await tx<{ id: string }[]>`INSERT INTO score_sheets (organization_id, competition_id, round_id, performance_id, entry_id, judge_id,
          rubric_id, score_values, status, author_account_id, submitted_at, supersedes_sheet_id, correction_id)
        VALUES (${organizationId}, ${competitionId}, ${original.round_id}, ${original.performance_id}, ${original.entry_id}, ${original.judge_id},
          ${original.rubric_id}, ${tx.json(correction.proposed_values)}, 'submitted', ${correction.requested_by_account_id}, now(), ${original.id}, ${correctionId})
        RETURNING id`;
      replacement = row!.id;
    }
    await tx`UPDATE score_corrections SET status = ${decision}, decided_by_account_id = ${actorAccountId}, decided_at = now(),
      decision_reason = ${reason}, replacement_sheet_id = ${replacement}, revision = revision + 1 WHERE id = ${correctionId}`;
    await recordAudit(tx, { organizationId, actorAccountId, action: `score.correction_${decision}`, subjectType: "score_sheet", subjectId: correction.sheet_id,
      details: { competitionId, correctionId, replacementSheetId: replacement, reason } });
    const [view] = await tx<CorrectionRow[]>`${correctionSelect(tx)} WHERE c.id = ${correctionId}`;
    return toCorrection(view!);
  });
}

export interface StandingsView {
  scope: { competitionId: string; roundId: string | null };
  rubric: { id: string; version: number };
  standings: (Standing & { displayName: string })[];
}

/** Gather the submitted sheets for the active rubric and rank with the pure `computeStandings`. */
export async function getStandings(organizationId: string, competitionId: string, options: { roundId?: string } = {}): Promise<StandingsView> {
  ids(organizationId, competitionId);
  if (options.roundId !== undefined && !isUuid(options.roundId)) throw new DomainError("round_not_found");
  const sql = getSqlClient();
  const rubric = await activeRubric(sql, organizationId, competitionId);
  if (options.roundId) {
    const [round] = await sql`SELECT 1 FROM rounds WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${options.roundId}`;
    if (!round) throw new DomainError("round_not_found");
  }
  const roundFilter = options.roundId ? sql`AND p.round_id = ${options.roundId}` : sql``;
  const entries = await sql<{ entry_id: string; display_name: string }[]>`
    SELECT DISTINCT p.entry_id, pa.display_name FROM performances p
    JOIN entries e ON e.organization_id = p.organization_id AND e.id = p.entry_id
    JOIN participants pa ON pa.organization_id = e.organization_id AND pa.id = e.participant_id
    WHERE p.organization_id = ${organizationId} AND p.competition_id = ${competitionId} ${roundFilter}
  `;
  const sheets = await sql<{ judge_id: string; entry_id: string; performance_id: string; score_values: ScoreValues; head: boolean }[]>`
    SELECT s.judge_id, s.entry_id, s.performance_id, s.score_values,
      EXISTS (SELECT 1 FROM round_judge_panels jp WHERE jp.round_id = s.round_id AND jp.judge_id = s.judge_id
        AND jp.panel_role = 'head' AND jp.removed_at IS NULL) AS head
    FROM score_sheets s JOIN performances p ON p.organization_id = s.organization_id AND p.id = s.performance_id
    WHERE s.organization_id = ${organizationId} AND s.competition_id = ${competitionId} AND s.rubric_id = ${rubric.id}
      AND s.status = 'submitted' ${roundFilter}
  `;
  const standings = computeStandings({
    rubric: rubric.definition,
    entryIds: entries.map(e => e.entry_id),
    sheets: sheets.map(s => ({ judgeId: s.judge_id, entryId: s.entry_id, performanceId: s.performance_id, values: s.score_values, headJudge: s.head }))
  });
  const names = new Map(entries.map(e => [e.entry_id, e.display_name]));
  return {
    scope: { competitionId, roundId: options.roundId ?? null },
    rubric: { id: rubric.id, version: rubric.version },
    standings: standings.map(s => ({ ...s, displayName: names.get(s.entryId) ?? "" }))
  };
}
