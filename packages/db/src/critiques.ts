import { DomainError, isUuid } from "@live-competition-engine/domain";
import { validateReason } from "@live-competition-engine/domain/applications";
import {
  appealResolutionNeedsReason, assertAppealTransition, assertCritiqueTransition, isAppealStatus, parseAppealBody, parseAppealKind,
  parseCritiqueBody, parseVisibility, submissionTarget, visibleToEntrant,
  type AppealKind, type AppealStatus, type CritiqueActor, type CritiqueStatus, type CritiqueVisibility
} from "@live-competition-engine/domain/critiques";
import { recordAudit, type Sql } from "./audit.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { assertPerformanceAccess, resolveJudge } from "./judges.ts";

/**
 * LC-21 critiques (optional feature `critiques`): judges write private or public critiques per
 * performance; public ones need producer approval; entrants read their own and can file appeals
 * or correction requests, resolved by producers with an append-only trail.
 */

function ids(...values: string[]): void {
  if (!values.every(isUuid)) throw new DomainError("not_found");
}
const revision = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DomainError("invalid_expected_revision");
  return value as number;
};
async function feature(organizationId: string, competitionId: string, accountId?: string): Promise<void> {
  try {
    await requireEnabledFeature("critiques", { organizationId, eventId: competitionId, ...(accountId ? { accountId } : {}) });
  } catch (error) {
    // The flag store refuses scopes outside the tenant (non-member account, foreign event): fail closed as 403.
    if (error instanceof Error && !(error instanceof DomainError) && /scope denied/.test(error.message)) throw new DomainError("forbidden");
    throw error;
  }
}

interface CritiqueRow {
  id: string; competition_id: string; round_id: string; performance_id: string; entry_id: string; judge_id: string; author_account_id: string;
  visibility: CritiqueVisibility; body: string; status: CritiqueStatus; revision: number; submitted_at: Date | null;
  moderated_at: Date | null; moderation_reason: string | null; created_at: Date; updated_at: Date;
}
export interface CritiqueView {
  id: string; roundId: string; performanceId: string; entryId: string; visibility: CritiqueVisibility; body: string; status: CritiqueStatus;
  revision: number; submittedAt: Date | null; moderatedAt: Date | null; moderationReason: string | null; updatedAt: Date;
}
const toView = (r: CritiqueRow): CritiqueView => ({
  id: r.id, roundId: r.round_id, performanceId: r.performance_id, entryId: r.entry_id, visibility: r.visibility, body: r.body,
  status: r.status, revision: r.revision, submittedAt: r.submitted_at, moderatedAt: r.moderated_at, moderationReason: r.moderation_reason, updatedAt: r.updated_at
});

async function event(tx: Sql, organizationId: string, critiqueId: string, actorKind: CritiqueActor | "entrant", actorAccountId: string,
  from: CritiqueStatus | null, to: CritiqueStatus, reason: string | null) {
  await tx`INSERT INTO critique_events (organization_id, critique_id, actor_kind, actor_account_id, from_status, to_status, reason)
    VALUES (${organizationId}, ${critiqueId}, ${actorKind}, ${actorAccountId}, ${from}, ${to}, ${reason})`;
}

async function loadCritique(tx: Sql, organizationId: string, competitionId: string, critiqueId: string): Promise<CritiqueRow> {
  const [row] = await tx<CritiqueRow[]>`SELECT * FROM critiques WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    AND id = ${critiqueId} FOR UPDATE`;
  if (!row) throw new DomainError("critique_not_found");
  return row;
}

/** Judge-only: the critique must be theirs (others' critiques are reported as missing). */
async function loadOwnCritique(tx: Sql, organizationId: string, competitionId: string, accountId: string, critiqueId: string) {
  const judge = await resolveJudge(tx, organizationId, competitionId, accountId);
  const row = await loadCritique(tx, organizationId, competitionId, critiqueId);
  if (row.judge_id !== judge.judgeId) throw new DomainError("critique_not_found");
  return row;
}

/** Create or edit the judge's draft for a performance (a rejected critique returns to draft when edited). */
export async function saveCritiqueDraft(
  organizationId: string, competitionId: string, accountId: string, roundId: string, performanceId: string,
  input: { body: unknown; visibility: unknown; expectedRevision?: unknown }
): Promise<CritiqueView> {
  ids(organizationId, competitionId, accountId, roundId, performanceId);
  const body = parseCritiqueBody(input.body);
  const visibility = parseVisibility(input.visibility);
  await feature(organizationId, competitionId, accountId);
  try {
    return await getSqlClient().begin(async tx => {
      const access = await assertPerformanceAccess(tx, organizationId, competitionId, accountId, roundId, performanceId, "score");
      const [current] = await tx<CritiqueRow[]>`SELECT * FROM critiques WHERE organization_id = ${organizationId} AND performance_id = ${performanceId}
        AND judge_id = ${access.judgeId} AND status NOT IN ('withdrawn','retracted') FOR UPDATE`;
      if (!current) {
        if (input.expectedRevision !== undefined && input.expectedRevision !== 0) throw new DomainError("critique_revision_conflict");
        const [row] = await tx<CritiqueRow[]>`INSERT INTO critiques (organization_id, competition_id, round_id, performance_id, entry_id, judge_id,
            author_account_id, visibility, body)
          VALUES (${organizationId}, ${competitionId}, ${roundId}, ${performanceId}, ${access.entryId}, ${access.judgeId}, ${accountId}, ${visibility}, ${body})
          RETURNING *`;
        await event(tx, organizationId, row!.id, "judge", accountId, null, "draft", null);
        return toView(row!);
      }
      if (current.revision !== input.expectedRevision) throw new DomainError("critique_revision_conflict");
      if (current.status === "rejected") assertCritiqueTransition("rejected", "draft", "judge");
      else if (current.status !== "draft") throw new DomainError("critique_locked_conflict");
      const [row] = await tx<CritiqueRow[]>`UPDATE critiques SET body = ${body}, visibility = ${visibility}, status = 'draft',
        revision = revision + 1, updated_at = now() WHERE id = ${current.id} RETURNING *`;
      if (current.status !== "draft") await event(tx, organizationId, current.id, "judge", accountId, current.status, "draft", null);
      return toView(row!);
    });
  } catch (error) {
    if ((error as { constraint_name?: string }).constraint_name === "critiques_one_current_uniq") throw new DomainError("critique_revision_conflict");
    throw error;
  }
}

/** Submit: private → delivered to the entrant; public → moderation queue. */
export async function submitCritique(organizationId: string, competitionId: string, accountId: string, critiqueId: string, expectedRevision: unknown): Promise<CritiqueView> {
  ids(organizationId, competitionId, accountId, critiqueId);
  const expected = revision(expectedRevision);
  await feature(organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const current = await loadOwnCritique(tx, organizationId, competitionId, accountId, critiqueId);
    // Recusal or panel removal after drafting blocks submission.
    await assertPerformanceAccess(tx, organizationId, competitionId, accountId, current.round_id, current.performance_id, "score");
    if (current.revision !== expected) throw new DomainError("critique_revision_conflict");
    const to = submissionTarget(current.visibility);
    assertCritiqueTransition(current.status, to, "judge");
    const [row] = await tx<CritiqueRow[]>`UPDATE critiques SET status = ${to}, submitted_at = now(), revision = revision + 1, updated_at = now()
      WHERE id = ${critiqueId} RETURNING *`;
    await event(tx, organizationId, critiqueId, "judge", accountId, current.status, to, null);
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "critique.submitted", subjectType: "critique", subjectId: critiqueId,
      details: { competitionId, performanceId: current.performance_id, visibility: current.visibility, status: to } });
    return toView(row!);
  });
}

export async function withdrawCritique(organizationId: string, competitionId: string, accountId: string, critiqueId: string, expectedRevision: unknown): Promise<CritiqueView> {
  ids(organizationId, competitionId, accountId, critiqueId);
  const expected = revision(expectedRevision);
  await feature(organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const current = await loadOwnCritique(tx, organizationId, competitionId, accountId, critiqueId);
    if (current.revision !== expected) throw new DomainError("critique_revision_conflict");
    assertCritiqueTransition(current.status, "withdrawn", "judge");
    const [row] = await tx<CritiqueRow[]>`UPDATE critiques SET status = 'withdrawn', revision = revision + 1, updated_at = now() WHERE id = ${critiqueId} RETURNING *`;
    await event(tx, organizationId, critiqueId, "judge", accountId, current.status, "withdrawn", null);
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "critique.withdrawn", subjectType: "critique", subjectId: critiqueId, details: { competitionId } });
    return toView(row!);
  });
}

export async function listJudgeCritiques(organizationId: string, competitionId: string, accountId: string): Promise<CritiqueView[]> {
  ids(organizationId, competitionId, accountId);
  await feature(organizationId, competitionId, accountId);
  const sql = getSqlClient();
  const judge = await resolveJudge(sql, organizationId, competitionId, accountId);
  const rows = await sql<CritiqueRow[]>`SELECT * FROM critiques WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    AND judge_id = ${judge.judgeId} ORDER BY updated_at DESC, id LIMIT 500`;
  return rows.map(toView);
}

/** Producer queue. Defaults to critiques awaiting moderation. Drafts are never shown. */
export async function listCritiquesForModeration(organizationId: string, competitionId: string, options: { status?: string } = {}): Promise<(CritiqueView & { judgeName: string; entrantName: string })[]> {
  ids(organizationId, competitionId);
  const status = options.status ?? "pending_moderation";
  if (!["delivered", "pending_moderation", "published", "rejected", "retracted"].includes(status)) throw new DomainError("invalid_status_filter");
  await feature(organizationId, competitionId);
  const rows = await getSqlClient()<(CritiqueRow & { judge_name: string; entrant_name: string })[]>`
    SELECT c.*, j.display_name AS judge_name, pa.display_name AS entrant_name FROM critiques c
    JOIN judges j ON j.organization_id = c.organization_id AND j.id = c.judge_id
    JOIN entries e ON e.organization_id = c.organization_id AND e.id = c.entry_id
    JOIN participants pa ON pa.organization_id = e.organization_id AND pa.id = e.participant_id
    WHERE c.organization_id = ${organizationId} AND c.competition_id = ${competitionId} AND c.status = ${status}
    ORDER BY c.submitted_at, c.id LIMIT 500`;
  return rows.map(r => ({ ...toView(r), judgeName: r.judge_name, entrantName: r.entrant_name }));
}

async function producerTransition(
  tx: Sql, organizationId: string, competitionId: string, actorAccountId: string, current: CritiqueRow, to: CritiqueStatus, reason: string | null
): Promise<CritiqueRow> {
  if (current.author_account_id === actorAccountId) throw new DomainError("self_approval_forbidden");
  assertCritiqueTransition(current.status, to, "producer");
  const [row] = await tx<CritiqueRow[]>`UPDATE critiques SET status = ${to}, moderated_by_account_id = ${actorAccountId}, moderated_at = now(),
    moderation_reason = ${reason}, revision = revision + 1, updated_at = now() WHERE id = ${current.id} RETURNING *`;
  await event(tx, organizationId, current.id, "producer", actorAccountId, current.status, to, reason);
  await recordAudit(tx, { organizationId, actorAccountId, action: `critique.${to}`, subjectType: "critique", subjectId: current.id,
    details: { competitionId, previousStatus: current.status, reason } });
  return row!;
}

/** Approve (publish) or reject a public critique. The author can never moderate their own critique. */
export async function moderateCritique(
  organizationId: string, competitionId: string, actorAccountId: string, critiqueId: string,
  input: { decision: unknown; reason?: unknown; expectedRevision: unknown }
): Promise<CritiqueView> {
  ids(organizationId, competitionId, actorAccountId, critiqueId);
  if (input.decision !== "published" && input.decision !== "rejected") throw new DomainError("invalid_moderation_decision");
  const decision = input.decision;
  const reason = validateReason(input.reason, decision === "rejected");
  const expected = revision(input.expectedRevision);
  await feature(organizationId, competitionId, actorAccountId);
  return getSqlClient().begin(async tx => {
    const current = await loadCritique(tx, organizationId, competitionId, critiqueId);
    if (current.revision !== expected) throw new DomainError("critique_revision_conflict");
    return toView(await producerTransition(tx, organizationId, competitionId, actorAccountId, current, decision, reason));
  });
}

export async function retractCritique(
  organizationId: string, competitionId: string, actorAccountId: string, critiqueId: string, input: { reason: unknown; expectedRevision: unknown }
): Promise<CritiqueView> {
  ids(organizationId, competitionId, actorAccountId, critiqueId);
  const reason = validateReason(input.reason, true);
  const expected = revision(input.expectedRevision);
  await feature(organizationId, competitionId, actorAccountId);
  return getSqlClient().begin(async tx => {
    const current = await loadCritique(tx, organizationId, competitionId, critiqueId);
    if (current.revision !== expected) throw new DomainError("critique_revision_conflict");
    return toView(await producerTransition(tx, organizationId, competitionId, actorAccountId, current, "retracted", reason));
  });
}

interface AppealRow {
  id: string; critique_id: string; requester_account_id: string; kind: AppealKind; body: string; status: AppealStatus; revision: number;
  resolution_reason: string | null; resolved_at: Date | null; created_at: Date;
}
export interface AppealView {
  id: string; critiqueId: string; kind: AppealKind; body: string; status: AppealStatus; revision: number;
  resolutionReason: string | null; resolvedAt: Date | null; createdAt: Date;
  trail: { actorKind: "entrant" | "producer"; fromStatus: AppealStatus | null; toStatus: AppealStatus; note: string | null; recordedAt: Date }[];
}

async function appealViews(sql: Sql, organizationId: string, rows: AppealRow[]): Promise<AppealView[]> {
  if (!rows.length) return [];
  const events = await sql<{ appeal_id: string; actor_kind: "entrant" | "producer"; from_status: AppealStatus | null; to_status: AppealStatus; note: string | null; recorded_at: Date }[]>`
    SELECT appeal_id, actor_kind, from_status, to_status, note, recorded_at FROM critique_appeal_events
    WHERE organization_id = ${organizationId} AND appeal_id = ANY(${rows.map(r => r.id)}::uuid[]) ORDER BY id`;
  return rows.map(r => ({
    id: r.id, critiqueId: r.critique_id, kind: r.kind, body: r.body, status: r.status, revision: r.revision,
    resolutionReason: r.resolution_reason, resolvedAt: r.resolved_at, createdAt: r.created_at,
    trail: events.filter(e => e.appeal_id === r.id).map(e => ({ actorKind: e.actor_kind, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, recordedAt: e.recorded_at }))
  }));
}

/** Critiques the entrant may read: delivered/published critiques of entries whose participant is their account. */
async function entrantCritique(tx: Sql, organizationId: string, competitionId: string, accountId: string, critiqueId: string): Promise<CritiqueRow> {
  const [row] = await tx<CritiqueRow[]>`
    SELECT c.* FROM critiques c
    JOIN entries e ON e.organization_id = c.organization_id AND e.id = c.entry_id
    JOIN participants pa ON pa.organization_id = e.organization_id AND pa.id = e.participant_id
    WHERE c.organization_id = ${organizationId} AND c.competition_id = ${competitionId} AND c.id = ${critiqueId} AND pa.account_id = ${accountId}`;
  if (!row || !visibleToEntrant(row.status)) throw new DomainError("critique_not_found");
  return row;
}

export interface EntrantCritique { id: string; roundLabel: string; performanceId: string; visibility: CritiqueVisibility; body: string; status: CritiqueStatus; submittedAt: Date | null; appeals: AppealView[]; }

/** The entrant's own critiques (judge identity is not disclosed). */
export async function listEntrantCritiques(organizationId: string, competitionId: string, accountId: string): Promise<EntrantCritique[]> {
  ids(organizationId, competitionId, accountId);
  await feature(organizationId, competitionId, accountId);
  const sql = getSqlClient();
  const rows = await sql<(CritiqueRow & { round_label: string })[]>`
    SELECT c.*, r.label AS round_label FROM critiques c
    JOIN rounds r ON r.organization_id = c.organization_id AND r.id = c.round_id
    JOIN entries e ON e.organization_id = c.organization_id AND e.id = c.entry_id
    JOIN participants pa ON pa.organization_id = e.organization_id AND pa.id = e.participant_id
    WHERE c.organization_id = ${organizationId} AND c.competition_id = ${competitionId} AND pa.account_id = ${accountId}
      AND c.status IN ('delivered','published')
    ORDER BY r.ordinal, c.submitted_at, c.id`;
  const appeals = rows.length ? await appealViews(sql, organizationId, await sql<AppealRow[]>`SELECT * FROM critique_appeals
    WHERE organization_id = ${organizationId} AND requester_account_id = ${accountId} AND critique_id = ANY(${rows.map(r => r.id)}::uuid[]) ORDER BY created_at`) : [];
  return rows.map(r => ({
    id: r.id, roundLabel: r.round_label, performanceId: r.performance_id, visibility: r.visibility, body: r.body, status: r.status,
    submittedAt: r.submitted_at, appeals: appeals.filter(a => a.critiqueId === r.id)
  }));
}

/** Anonymous read model: published public critiques of a non-draft competition. */
export async function listPublicCritiques(organizationId: string, competitionId: string): Promise<{ id: string; performanceId: string; entrantName: string; roundLabel: string; body: string; publishedAt: Date | null }[]> {
  ids(organizationId, competitionId);
  await feature(organizationId, competitionId);
  const rows = await getSqlClient()<{ id: string; performance_id: string; entrant_name: string; round_label: string; body: string; moderated_at: Date | null }[]>`
    SELECT c.id, c.performance_id, pa.display_name AS entrant_name, r.label AS round_label, c.body, c.moderated_at FROM critiques c
    JOIN competitions comp ON comp.organization_id = c.organization_id AND comp.id = c.competition_id
    JOIN rounds r ON r.organization_id = c.organization_id AND r.id = c.round_id
    JOIN entries e ON e.organization_id = c.organization_id AND e.id = c.entry_id
    JOIN participants pa ON pa.organization_id = e.organization_id AND pa.id = e.participant_id
    WHERE c.organization_id = ${organizationId} AND c.competition_id = ${competitionId}
      AND c.status = 'published' AND c.visibility = 'public' AND comp.status <> 'draft'
    ORDER BY r.ordinal, c.moderated_at, c.id LIMIT 500`;
  return rows.map(r => ({ id: r.id, performanceId: r.performance_id, entrantName: r.entrant_name, roundLabel: r.round_label, body: r.body, publishedAt: r.moderated_at }));
}

/** Entrant files an appeal or correction request against one of their critiques (one open at a time). */
export async function fileAppeal(
  organizationId: string, competitionId: string, accountId: string, critiqueId: string, input: { kind: unknown; body: unknown }
): Promise<AppealView> {
  ids(organizationId, competitionId, accountId, critiqueId);
  const kind = parseAppealKind(input.kind);
  const body = parseAppealBody(input.body);
  await feature(organizationId, competitionId, accountId);
  try {
    return await getSqlClient().begin(async tx => {
      await entrantCritique(tx, organizationId, competitionId, accountId, critiqueId);
      const [row] = await tx<AppealRow[]>`INSERT INTO critique_appeals (organization_id, competition_id, critique_id, requester_account_id, kind, body)
        VALUES (${organizationId}, ${competitionId}, ${critiqueId}, ${accountId}, ${kind}, ${body}) RETURNING *`;
      await tx`INSERT INTO critique_appeal_events (organization_id, appeal_id, actor_kind, actor_account_id, from_status, to_status, note)
        VALUES (${organizationId}, ${row!.id}, 'entrant', ${accountId}, NULL, 'open', NULL)`;
      await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "critique.appeal_filed", subjectType: "critique_appeal", subjectId: row!.id,
        details: { competitionId, critiqueId, kind } });
      return (await appealViews(tx, organizationId, [row!]))[0]!;
    });
  } catch (error) {
    if ((error as { constraint_name?: string }).constraint_name === "critique_appeals_one_open_uniq") throw new DomainError("appeal_pending_conflict");
    throw error;
  }
}

async function appealTransition(
  tx: Sql, organizationId: string, competitionId: string, appeal: AppealRow, to: AppealStatus, actorKind: "entrant" | "producer", actorAccountId: string, note: string | null
): Promise<AppealRow> {
  assertAppealTransition(appeal.status, to, actorKind);
  const resolved = to === "upheld" || to === "dismissed";
  const [row] = await tx<AppealRow[]>`UPDATE critique_appeals SET status = ${to}, revision = revision + 1,
      resolution_reason = ${resolved ? note : null}, resolved_by_account_id = ${resolved ? actorAccountId : null}, resolved_at = ${resolved ? new Date() : null}
    WHERE id = ${appeal.id} RETURNING *`;
  await tx`INSERT INTO critique_appeal_events (organization_id, appeal_id, actor_kind, actor_account_id, from_status, to_status, note)
    VALUES (${organizationId}, ${appeal.id}, ${actorKind}, ${actorAccountId}, ${appeal.status}, ${to}, ${note})`;
  await recordAudit(tx, { organizationId, actorAccountId, action: `critique.appeal_${to}`, subjectType: "critique_appeal", subjectId: appeal.id,
    details: { competitionId, critiqueId: appeal.critique_id, previousStatus: appeal.status, note } });
  return row!;
}

export async function withdrawAppeal(organizationId: string, competitionId: string, accountId: string, appealId: string, expectedRevision: unknown): Promise<AppealView> {
  ids(organizationId, competitionId, accountId, appealId);
  const expected = revision(expectedRevision);
  await feature(organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const [appeal] = await tx<AppealRow[]>`SELECT * FROM critique_appeals WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      AND id = ${appealId} AND requester_account_id = ${accountId} FOR UPDATE`;
    if (!appeal) throw new DomainError("appeal_not_found");
    if (appeal.revision !== expected) throw new DomainError("appeal_revision_conflict");
    return (await appealViews(tx, organizationId, [await appealTransition(tx, organizationId, competitionId, appeal, "withdrawn", "entrant", accountId, null)]))[0]!;
  });
}

/**
 * Producer review: move to under_review, or resolve (upheld/dismissed, reason required). Upholding with
 * `retract: true` also retracts the critique. The critique's author cannot resolve appeals against it.
 */
export async function resolveAppeal(
  organizationId: string, competitionId: string, actorAccountId: string, appealId: string,
  input: { status: unknown; reason?: unknown; retract?: unknown; expectedRevision: unknown }
): Promise<AppealView> {
  ids(organizationId, competitionId, actorAccountId, appealId);
  if (!isAppealStatus(input.status) || !["under_review", "upheld", "dismissed"].includes(input.status)) throw new DomainError("invalid_appeal_status");
  const to = input.status;
  const note = validateReason(input.reason, appealResolutionNeedsReason(to));
  if (input.retract !== undefined && typeof input.retract !== "boolean") throw new DomainError("invalid_retract_flag");
  if (input.retract && to !== "upheld") throw new DomainError("invalid_retract_flag");
  const expected = revision(input.expectedRevision);
  await feature(organizationId, competitionId, actorAccountId);
  return getSqlClient().begin(async tx => {
    const [appeal] = await tx<AppealRow[]>`SELECT * FROM critique_appeals WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      AND id = ${appealId} FOR UPDATE`;
    if (!appeal) throw new DomainError("appeal_not_found");
    if (appeal.revision !== expected) throw new DomainError("appeal_revision_conflict");
    const critique = await loadCritique(tx, organizationId, competitionId, appeal.critique_id);
    if (critique.author_account_id === actorAccountId) throw new DomainError("self_approval_forbidden");
    const row = await appealTransition(tx, organizationId, competitionId, appeal, to, "producer", actorAccountId, note);
    if (input.retract) await producerTransition(tx, organizationId, competitionId, actorAccountId, critique, "retracted", note);
    return (await appealViews(tx, organizationId, [row]))[0]!;
  });
}

export async function listAppeals(organizationId: string, competitionId: string, options: { status?: string } = {}): Promise<(AppealView & { critiqueBody: string; critiqueStatus: CritiqueStatus })[]> {
  ids(organizationId, competitionId);
  if (options.status !== undefined && !isAppealStatus(options.status)) throw new DomainError("invalid_status_filter");
  await feature(organizationId, competitionId);
  const sql = getSqlClient();
  const rows = await sql<(AppealRow & { critique_body: string; critique_status: CritiqueStatus })[]>`
    SELECT a.*, c.body AS critique_body, c.status AS critique_status FROM critique_appeals a
    JOIN critiques c ON c.organization_id = a.organization_id AND c.id = a.critique_id
    WHERE a.organization_id = ${organizationId} AND a.competition_id = ${competitionId}
      ${options.status ? sql`AND a.status = ${options.status}` : sql``}
    ORDER BY a.created_at, a.id LIMIT 500`;
  const views = await appealViews(sql, organizationId, rows);
  return views.map((v, i) => ({ ...v, critiqueBody: rows[i]!.critique_body, critiqueStatus: rows[i]!.critique_status }));
}
