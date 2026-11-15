import { createHash } from "node:crypto";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  assertReportTransition,
  optionalNote,
  parseAppealDecision,
  parseReportInput,
  parseReportStatus,
  parseSubject,
  REPORT_RATE_LIMITS,
  requireNote,
  type ModerationSubjectType,
  type ReportStatus
} from "@live-competition-engine/domain/moderation";
import type { ModerationOverviewCounts } from "./admin-overview.ts";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";
import { consumeRateLimit } from "./rate-limit.ts";

/**
 * LC-46 moderation and trust/safety. Queue/decision functions require the caller to have
 * authorized tenant.manage; submitReport accepts members or anonymous reporters; fileAppeal
 * is called by the authenticated affected account. Every decision is audited.
 */

export type Reporter = { accountId: string } | { anonymousKey: string };

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function reporterKey(organizationId: string, reporter: Reporter): string {
  if ("accountId" in reporter) return digest(`account\0${organizationId}\0${reporter.accountId}`);
  if (typeof reporter.anonymousKey !== "string" || reporter.anonymousKey.length < 1 || reporter.anonymousKey.length > 200) {
    throw new DomainError("invalid_reporter");
  }
  return digest(`anonymous\0${organizationId}\0${reporter.anonymousKey}`);
}

export interface ReportRecord {
  id: string;
  subjectType: ModerationSubjectType;
  subjectId: string;
  reason: string;
  details: string | null;
  status: ReportStatus;
  revision: number;
  anonymous: boolean;
  createdAt: Date;
}

type ReportRow = {
  id: string; subject_type: ModerationSubjectType; subject_id: string; reason: string; details: string | null;
  status: ReportStatus; revision: number; reporter_account_id: string | null; created_at: Date;
};
const toReport = (row: ReportRow): ReportRecord => ({
  id: row.id, subjectType: row.subject_type, subjectId: row.subject_id, reason: row.reason, details: row.details,
  status: row.status, revision: row.revision, anonymous: row.reporter_account_id === null, createdAt: row.created_at
});

/**
 * File a report. Rate limited per reporter (fixed hourly window, consumed even when the
 * report is a duplicate). A reporter with an unresolved report on the same subject gets
 * that report back (idempotent) instead of a new row.
 */
export async function submitReport(
  organizationId: string,
  reporter: Reporter,
  input: Record<string, unknown>,
  now = new Date()
): Promise<{ report: ReportRecord; duplicate: boolean }> {
  const report = parseReportInput(input);
  const key = reporterKey(organizationId, reporter);
  const policy = "accountId" in reporter ? REPORT_RATE_LIMITS.member : REPORT_RATE_LIMITS.anonymous;
  const org = await getSqlClient()`SELECT 1 FROM organizations WHERE id = ${organizationId}`;
  if (org.length !== 1) throw new DomainError("organization_not_found");
  await consumeRateLimit(`moderation-report:${organizationId}:${key}`, policy.limit, policy.windowMs, { now });
  return getSqlClient().begin(async tx => {
    const accountId = "accountId" in reporter ? reporter.accountId : null;
    const inserted = await tx<ReportRow[]>`
      INSERT INTO moderation_reports (organization_id, subject_type, subject_id, reporter_account_id, reporter_key, reason, details)
      VALUES (${organizationId}, ${report.subjectType}, ${report.subjectId}, ${accountId}, ${key}, ${report.reason}, ${report.details})
      ON CONFLICT (organization_id, subject_type, subject_id, reporter_key) WHERE status IN ('open', 'triaged') DO NOTHING
      RETURNING id, subject_type, subject_id, reason, details, status, revision, reporter_account_id, created_at
    `;
    if (inserted.length === 0) {
      const [existing] = await tx<ReportRow[]>`
        SELECT id, subject_type, subject_id, reason, details, status, revision, reporter_account_id, created_at
        FROM moderation_reports
        WHERE organization_id = ${organizationId} AND subject_type = ${report.subjectType} AND subject_id = ${report.subjectId}
          AND reporter_key = ${key} AND status IN ('open', 'triaged')
      `;
      if (!existing) throw new DomainError("report_conflict");
      return { report: toReport(existing), duplicate: true };
    }
    const row = inserted[0]!;
    await recordAudit(tx, {
      organizationId, actorAccountId: accountId, action: "moderation.report_submitted", subjectType: "moderation_report",
      subjectId: row.id, details: { subjectType: report.subjectType, subjectId: report.subjectId, reason: report.reason, anonymous: accountId === null }
    });
    return { report: toReport(row), duplicate: false };
  });
}

export async function listReports(organizationId: string, options: { status?: unknown; limit?: number } = {}): Promise<ReportRecord[]> {
  const status = options.status === undefined || options.status === null ? null : parseReportStatus(options.status);
  const sql = getSqlClient();
  const rows = await sql<ReportRow[]>`
    SELECT id, subject_type, subject_id, reason, details, status, revision, reporter_account_id, created_at
    FROM moderation_reports WHERE organization_id = ${organizationId}
      ${status ? sql`AND status = ${status}` : sql``}
    ORDER BY created_at LIMIT ${Math.min(Math.max(options.limit ?? 100, 1), 500)}
  `;
  return rows.map(toReport);
}

export async function getReport(organizationId: string, reportId: string) {
  if (!isUuid(reportId)) return null;
  const sql = getSqlClient();
  const [row] = await sql<ReportRow[]>`
    SELECT id, subject_type, subject_id, reason, details, status, revision, reporter_account_id, created_at
    FROM moderation_reports WHERE organization_id = ${organizationId} AND id = ${reportId}
  `;
  if (!row) return null;
  const [history, evidence] = await Promise.all([
    sql<{ from_status: string; to_status: string; actor_account_id: string; note: string | null; created_at: Date }[]>`
      SELECT from_status, to_status, actor_account_id, note, created_at FROM moderation_report_transitions
      WHERE organization_id = ${organizationId} AND report_id = ${reportId} ORDER BY id`,
    sql<{ id: string; kind: string; body: string | null; media_id: string | null; created_at: Date }[]>`
      SELECT id, kind, body, media_id, created_at FROM moderation_evidence
      WHERE organization_id = ${organizationId} AND report_id = ${reportId} ORDER BY created_at`
  ]);
  return { ...toReport(row), history, evidence };
}

async function transitionLocked(
  tx: Sql, organizationId: string, actorAccountId: string, reportId: string, to: ReportStatus,
  note: string | null, expectedRevision: number | null, now: Date
): Promise<ReportRecord> {
  const [row] = await tx<ReportRow[]>`
    SELECT id, subject_type, subject_id, reason, details, status, revision, reporter_account_id, created_at
    FROM moderation_reports WHERE organization_id = ${organizationId} AND id = ${reportId} FOR UPDATE
  `;
  if (!row) throw new DomainError("report_not_found");
  if (expectedRevision !== null && row.revision !== expectedRevision) throw new DomainError("report_revision_conflict");
  assertReportTransition(row.status, to);
  const terminal = to === "actioned" || to === "dismissed";
  const [updated] = await tx<ReportRow[]>`
    UPDATE moderation_reports SET status = ${to}, revision = revision + 1, updated_at = ${now},
      resolved_at = ${terminal ? now : null}, resolved_by_account_id = ${terminal ? actorAccountId : null}
    WHERE organization_id = ${organizationId} AND id = ${reportId}
    RETURNING id, subject_type, subject_id, reason, details, status, revision, reporter_account_id, created_at
  `;
  await tx`
    INSERT INTO moderation_report_transitions (organization_id, report_id, from_status, to_status, actor_account_id, note, created_at)
    VALUES (${organizationId}, ${reportId}, ${row.status}, ${to}, ${actorAccountId}, ${note}, ${now})
  `;
  await recordAudit(tx, {
    organizationId, actorAccountId, action: `moderation.report_${to}`, subjectType: "moderation_report", subjectId: reportId,
    details: { from: row.status, to, note }
  });
  return toReport(updated!);
}

export async function transitionReport(
  organizationId: string, actorAccountId: string, reportId: string,
  input: { to: unknown; note?: unknown; expectedRevision?: unknown }, now = new Date()
): Promise<ReportRecord> {
  if (!isUuid(reportId)) throw new DomainError("report_not_found");
  const to = parseReportStatus(input.to);
  const note = optionalNote(input.note, "invalid_note");
  const expected = input.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1) throw new DomainError("invalid_expected_revision");
  if (to === "actioned") throw new DomainError("use_moderation_action_to_resolve");
  return getSqlClient().begin(tx => transitionLocked(tx, organizationId, actorAccountId, reportId, to, note, expected, now));
}

export interface ActionRecord {
  id: string;
  subjectType: ModerationSubjectType;
  subjectId: string;
  action: "hide" | "takedown";
  reportId: string | null;
  affectedAccountId: string | null;
  reason: string;
  createdAt: Date;
  reversedAt: Date | null;
}

type ActionRow = {
  id: string; subject_type: ModerationSubjectType; subject_id: string; action: "hide" | "takedown"; report_id: string | null;
  affected_account_id: string | null; reason: string; created_at: Date; reversed_at: Date | null;
};
const toAction = (row: ActionRow): ActionRecord => ({
  id: row.id, subjectType: row.subject_type, subjectId: row.subject_id, action: row.action, reportId: row.report_id,
  affectedAccountId: row.affected_account_id, reason: row.reason, createdAt: row.created_at, reversedAt: row.reversed_at
});

/** Hide or take down any subject. With reportId, the report is resolved as actioned atomically. */
export async function takeModerationAction(
  organizationId: string, actorAccountId: string, input: Record<string, unknown>, now = new Date()
): Promise<ActionRecord> {
  const subject = parseSubject(input);
  if (input.action !== "hide" && input.action !== "takedown") throw new DomainError("invalid_moderation_action");
  const reason = requireNote(input.reason, "invalid_reason");
  const reportId = input.reportId ?? null;
  if (reportId !== null && !isUuid(reportId)) throw new DomainError("report_not_found");
  const affected = input.affectedAccountId ?? null;
  if (affected !== null && !isUuid(affected)) throw new DomainError("invalid_affected_account");
  return getSqlClient().begin(async tx => {
    if (affected) {
      const member = await tx`SELECT 1 FROM organization_memberships WHERE organization_id = ${organizationId} AND account_id = ${affected as string}`;
      if (member.length !== 1) throw new DomainError("affected_account_not_found");
    }
    if (reportId) {
      const [report] = await tx<{ subject_type: string; subject_id: string }[]>`
        SELECT subject_type, subject_id FROM moderation_reports WHERE organization_id = ${organizationId} AND id = ${reportId as string}`;
      if (!report) throw new DomainError("report_not_found");
      if (report.subject_type !== subject.subjectType || report.subject_id !== subject.subjectId) throw new DomainError("report_subject_mismatch");
      await transitionLocked(tx, organizationId, actorAccountId, reportId as string, "actioned", reason, null, now);
    }
    const [row] = await tx<ActionRow[]>`
      INSERT INTO moderation_actions (organization_id, subject_type, subject_id, action, report_id, affected_account_id, reason, actor_account_id, created_at)
      VALUES (${organizationId}, ${subject.subjectType}, ${subject.subjectId}, ${input.action as string}, ${reportId as string | null},
        ${affected as string | null}, ${reason}, ${actorAccountId}, ${now})
      RETURNING id, subject_type, subject_id, action, report_id, affected_account_id, reason, created_at, reversed_at
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: `moderation.${input.action as string}`, subjectType: "moderation_action", subjectId: row!.id,
      details: { subjectType: subject.subjectType, subjectId: subject.subjectId, reportId, affectedAccountId: affected }
    });
    return toAction(row!);
  });
}

async function reverseLocked(tx: Sql, organizationId: string, actorAccountId: string, actionId: string, reason: string, now: Date) {
  const rows = await tx`
    UPDATE moderation_actions SET reversed_at = ${now}, reversed_by_account_id = ${actorAccountId}, reversal_reason = ${reason}
    WHERE organization_id = ${organizationId} AND id = ${actionId} AND reversed_at IS NULL RETURNING id
  `;
  if (rows.length !== 1) throw new DomainError("active_action_not_found");
  await recordAudit(tx, {
    organizationId, actorAccountId, action: "moderation.action_reversed", subjectType: "moderation_action", subjectId: actionId, details: { reason }
  });
}

export async function reverseModerationAction(organizationId: string, actorAccountId: string, actionId: string, reasonInput: unknown, now = new Date()): Promise<void> {
  if (!isUuid(actionId)) throw new DomainError("active_action_not_found");
  const reason = requireNote(reasonInput, "invalid_reason");
  await getSqlClient().begin(tx => reverseLocked(tx, organizationId, actorAccountId, actionId, reason, now));
}

/** Other modules call this before rendering a subject publicly. Fails closed on invalid input. */
export async function isSubjectHidden(organizationId: string, subjectType: string, subjectId: string, sql: Sql = getSqlClient()): Promise<boolean> {
  if (!isUuid(organizationId)) return true;
  const rows = await sql`
    SELECT 1 FROM moderation_actions
    WHERE organization_id = ${organizationId} AND subject_type = ${subjectType} AND subject_id = ${subjectId} AND reversed_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function listActions(organizationId: string, options: { activeOnly?: boolean; limit?: number } = {}): Promise<ActionRecord[]> {
  const sql = getSqlClient();
  const rows = await sql<ActionRow[]>`
    SELECT id, subject_type, subject_id, action, report_id, affected_account_id, reason, created_at, reversed_at
    FROM moderation_actions WHERE organization_id = ${organizationId}
      ${options.activeOnly ? sql`AND reversed_at IS NULL` : sql``}
    ORDER BY created_at DESC LIMIT ${Math.min(Math.max(options.limit ?? 100, 1), 500)}
  `;
  return rows.map(toAction);
}

/** Actions affecting this account (what it may appeal). */
export async function listActionsAffecting(organizationId: string, accountId: string): Promise<ActionRecord[]> {
  const rows = await getSqlClient()<ActionRow[]>`
    SELECT id, subject_type, subject_id, action, report_id, affected_account_id, reason, created_at, reversed_at
    FROM moderation_actions WHERE organization_id = ${organizationId} AND affected_account_id = ${accountId}
    ORDER BY created_at DESC LIMIT 200
  `;
  return rows.map(toAction);
}

export async function fileAppeal(
  organizationId: string, appellantAccountId: string, actionId: string, statementInput: unknown, now = new Date()
): Promise<{ id: string; status: "open" }> {
  if (!isUuid(actionId)) throw new DomainError("action_not_found");
  const statement = requireNote(statementInput, "invalid_statement", 4000);
  try {
    return await getSqlClient().begin(async tx => {
      const [action] = await tx<{ affected_account_id: string | null; reversed_at: Date | null }[]>`
        SELECT affected_account_id, reversed_at FROM moderation_actions
        WHERE organization_id = ${organizationId} AND id = ${actionId} FOR SHARE
      `;
      // Only the affected account may appeal; others get not-found so actions are not enumerable.
      if (!action || action.affected_account_id !== appellantAccountId) throw new DomainError("action_not_found");
      if (action.reversed_at) throw new DomainError("invalid_state_action_reversed");
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO moderation_appeals (organization_id, action_id, appellant_account_id, statement, created_at)
        VALUES (${organizationId}, ${actionId}, ${appellantAccountId}, ${statement}, ${now}) RETURNING id
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId: appellantAccountId, action: "moderation.appeal_filed", subjectType: "moderation_appeal",
        subjectId: row!.id, details: { actionId }
      });
      return { id: row!.id, status: "open" as const };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") throw new DomainError("appeal_conflict");
    throw error;
  }
}

export async function decideAppeal(
  organizationId: string, actorAccountId: string, appealId: string, input: { decision: unknown; note?: unknown }, now = new Date()
): Promise<{ id: string; status: "upheld" | "overturned" }> {
  if (!isUuid(appealId)) throw new DomainError("appeal_not_found");
  const decision = parseAppealDecision(input.decision);
  const note = optionalNote(input.note, "invalid_note");
  return getSqlClient().begin(async tx => {
    const [appeal] = await tx<{ action_id: string; status: string; appellant_account_id: string }[]>`
      SELECT action_id, status, appellant_account_id FROM moderation_appeals
      WHERE organization_id = ${organizationId} AND id = ${appealId} FOR UPDATE
    `;
    if (!appeal) throw new DomainError("appeal_not_found");
    if (appeal.status !== "open") throw new DomainError("invalid_state_appeal_decided");
    if (appeal.appellant_account_id === actorAccountId) throw new DomainError("forbidden");
    await tx`
      UPDATE moderation_appeals SET status = ${decision}, decided_by_account_id = ${actorAccountId}, decided_at = ${now}, decision_note = ${note}
      WHERE organization_id = ${organizationId} AND id = ${appealId}
    `;
    if (decision === "overturned") {
      await reverseLocked(tx, organizationId, actorAccountId, appeal.action_id, note ?? "appeal overturned", now);
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: `moderation.appeal_${decision}`, subjectType: "moderation_appeal", subjectId: appealId,
      details: { actionId: appeal.action_id, note }
    });
    return { id: appealId, status: decision };
  });
}

export async function listAppeals(organizationId: string, status: unknown = "open") {
  if (status !== "open" && status !== "upheld" && status !== "overturned") throw new DomainError("invalid_appeal_status");
  return getSqlClient()<{ id: string; action_id: string; appellant_account_id: string; statement: string; status: string; created_at: Date }[]>`
    SELECT id, action_id, appellant_account_id, statement, status, created_at FROM moderation_appeals
    WHERE organization_id = ${organizationId} AND status = ${status} ORDER BY created_at LIMIT 200
  `;
}

export async function addEvidence(
  organizationId: string, actorAccountId: string, reportId: string, input: { kind?: unknown; body?: unknown; mediaId?: unknown }
): Promise<{ id: string }> {
  if (!isUuid(reportId)) throw new DomainError("report_not_found");
  let body: string | null = null;
  let mediaId: string | null = null;
  if (input.kind === "text") body = requireNote(input.body, "invalid_evidence_body", 8000);
  else if (input.kind === "media") {
    if (!isUuid(input.mediaId)) throw new DomainError("invalid_evidence_media");
    mediaId = input.mediaId;
    body = optionalNote(input.body, "invalid_evidence_body", 8000);
  } else throw new DomainError("invalid_evidence_kind");
  return getSqlClient().begin(async tx => {
    const report = await tx`SELECT 1 FROM moderation_reports WHERE organization_id = ${organizationId} AND id = ${reportId} FOR SHARE`;
    if (report.length !== 1) throw new DomainError("report_not_found");
    if (mediaId) {
      const media = await tx`SELECT 1 FROM media_library WHERE organization_id = ${organizationId} AND id = ${mediaId}`;
      if (media.length !== 1) throw new DomainError("media_not_found");
    }
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO moderation_evidence (organization_id, report_id, kind, body, media_id, added_by_account_id)
      VALUES (${organizationId}, ${reportId}, ${input.kind as string}, ${body}, ${mediaId}, ${actorAccountId}) RETURNING id
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "moderation.evidence_added", subjectType: "moderation_report", subjectId: reportId,
      details: { evidenceId: row!.id, kind: input.kind, mediaId }
    });
    return { id: row!.id };
  });
}

export async function placeLegalHold(
  organizationId: string, actorAccountId: string, input: Record<string, unknown>
): Promise<{ id: string }> {
  const subject = parseSubject(input);
  const reason = requireNote(input.reason, "invalid_reason");
  try {
    return await getSqlClient().begin(async tx => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO moderation_legal_holds (organization_id, subject_type, subject_id, reason, placed_by_account_id)
        VALUES (${organizationId}, ${subject.subjectType}, ${subject.subjectId}, ${reason}, ${actorAccountId}) RETURNING id
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "moderation.legal_hold_placed", subjectType: "legal_hold", subjectId: row!.id,
        details: { ...subject, reason }
      });
      return { id: row!.id };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") throw new DomainError("legal_hold_conflict");
    throw error;
  }
}

export async function releaseLegalHold(organizationId: string, actorAccountId: string, holdId: string): Promise<void> {
  if (!isUuid(holdId)) throw new DomainError("legal_hold_not_found");
  await getSqlClient().begin(async tx => {
    const rows = await tx`
      UPDATE moderation_legal_holds SET released_at = now(), released_by_account_id = ${actorAccountId}
      WHERE organization_id = ${organizationId} AND id = ${holdId} AND released_at IS NULL RETURNING id
    `;
    if (rows.length !== 1) throw new DomainError("legal_hold_not_found");
    await recordAudit(tx, { organizationId, actorAccountId, action: "moderation.legal_hold_released", subjectType: "legal_hold", subjectId: holdId });
  });
}

/** Other modules call this before deleting a subject's records. */
export async function isUnderLegalHold(organizationId: string, subjectType: string, subjectId: string): Promise<boolean> {
  const rows = await getSqlClient()`
    SELECT 1 FROM moderation_legal_holds WHERE organization_id = ${organizationId}
      AND subject_type = ${subjectType} AND subject_id = ${subjectId} AND released_at IS NULL
  `;
  return rows.length > 0;
}

/** Retention deletion of a resolved report. A database trigger refuses it under legal hold. */
export async function deleteReport(organizationId: string, actorAccountId: string, reportId: string): Promise<void> {
  if (!isUuid(reportId)) throw new DomainError("report_not_found");
  try {
    await getSqlClient().begin(async tx => {
      const [row] = await tx<{ status: ReportStatus }[]>`
        SELECT status FROM moderation_reports WHERE organization_id = ${organizationId} AND id = ${reportId} FOR UPDATE`;
      if (!row) throw new DomainError("report_not_found");
      if (row.status === "open" || row.status === "triaged") throw new DomainError("invalid_state_report_unresolved");
      const actions = await tx`SELECT 1 FROM moderation_actions WHERE organization_id = ${organizationId} AND report_id = ${reportId}`;
      if (actions.length > 0) throw new DomainError("invalid_state_report_has_actions");
      await tx`DELETE FROM moderation_reports WHERE organization_id = ${organizationId} AND id = ${reportId}`;
      await recordAudit(tx, { organizationId, actorAccountId, action: "moderation.report_deleted", subjectType: "moderation_report", subjectId: reportId });
    });
  } catch (error) {
    if ((error as { hint?: string })?.hint === "legal_hold_active") throw new DomainError("legal_hold_active");
    throw error;
  }
}

export async function moderationOverviewCounts(organizationId: string): Promise<ModerationOverviewCounts> {
  const sql = getSqlClient();
  const [reports, [counts]] = await Promise.all([
    sql<{ status: ReportStatus; count: number }[]>`
      SELECT status, count(*)::int AS count FROM moderation_reports WHERE organization_id = ${organizationId} GROUP BY status`,
    sql<{ actions: number; appeals: number; holds: number }[]>`
      SELECT
        (SELECT count(*)::int FROM moderation_actions WHERE organization_id = ${organizationId} AND reversed_at IS NULL) AS actions,
        (SELECT count(*)::int FROM moderation_appeals WHERE organization_id = ${organizationId} AND status = 'open') AS appeals,
        (SELECT count(*)::int FROM moderation_legal_holds WHERE organization_id = ${organizationId} AND released_at IS NULL) AS holds`
  ]);
  const byStatus = { open: 0, triaged: 0, actioned: 0, dismissed: 0 };
  for (const row of reports) byStatus[row.status] = row.count;
  return { reports: byStatus, activeActions: counts!.actions, openAppeals: counts!.appeals, activeLegalHolds: counts!.holds };
}
