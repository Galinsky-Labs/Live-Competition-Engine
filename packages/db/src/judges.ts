import { createHash, randomBytes } from "node:crypto";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  assertInvitationUsable, assertInviteToken, assertJudgeMayScore, assertJudgeMayView, assertJudgeTransition, holdsJudgeRole,
  isJudgeStatus, normalizeEmail, parseInviteLifetimeHours, parseJudgeName, parseRecusalReason, type JudgeStatus
} from "@live-competition-engine/domain/judges";
import type { PanelRole } from "@live-competition-engine/domain/selection";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-19 judge system: invitations, acceptance (links account + grants the competition-scoped
 * `judge` role), verification/suspension/removal, conflict-of-interest recusals, and the
 * access checks every judge-facing read or write goes through.
 */

export const hashInvitationToken = (token: string) => createHash("sha256").update(`judge-invite\0${token}`, "utf8").digest("hex");

function ids(...values: string[]): void {
  if (!values.every(isUuid)) throw new DomainError("not_found");
}

export interface InvitationView {
  id: string; email: string; displayName: string; createdAt: Date; expiresAt: Date;
  status: "open" | "accepted" | "revoked" | "expired"; judgeId: string | null;
}

interface InvitationRow {
  id: string; competition_id: string; email: string; display_name: string; created_by_account_id: string; created_at: Date;
  expires_at: Date; accepted_at: Date | null; accepted_account_id: string | null; judge_id: string | null; revoked_at: Date | null;
}

const toInvitation = (row: InvitationRow, now = new Date()): InvitationView => ({
  id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at, expiresAt: row.expires_at, judgeId: row.judge_id,
  status: row.accepted_at ? "accepted" : row.revoked_at ? "revoked" : row.expires_at.getTime() <= now.getTime() ? "expired" : "open"
});

async function assertCompetition(tx: Sql, organizationId: string, competitionId: string): Promise<void> {
  const [row] = await tx`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
  if (!row) throw new DomainError("competition_not_found");
}

/**
 * Create an invitation and return the raw token exactly once. Only its hash is stored.
 * Re-inviting the same email revokes the previous open invitation.
 * Delivery (email) is out of band: the producer passes the link on.
 */
export async function inviteJudge(
  organizationId: string, competitionId: string, actorAccountId: string,
  input: { email: unknown; displayName: unknown; expiresInHours?: unknown }, now = new Date()
): Promise<{ invitation: InvitationView; token: string }> {
  ids(organizationId, competitionId, actorAccountId);
  const email = normalizeEmail(input.email);
  const displayName = parseJudgeName(input.displayName);
  const hours = parseInviteLifetimeHours(input.expiresInHours);
  const token = randomBytes(32).toString("base64url");
  return getSqlClient().begin(async tx => {
    await assertCompetition(tx, organizationId, competitionId);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`judge-invite:${competitionId}:${email}`}, 0))`;
    const replaced = await tx<{ id: string }[]>`
      UPDATE judge_invitations SET revoked_at = ${now}, revoked_by_account_id = ${actorAccountId}
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND email = ${email}
        AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
    `;
    const [row] = await tx<InvitationRow[]>`
      INSERT INTO judge_invitations (organization_id, competition_id, email, display_name, token_hash, created_by_account_id, created_at, expires_at)
      VALUES (${organizationId}, ${competitionId}, ${email}, ${displayName}, ${hashInvitationToken(token)}, ${actorAccountId}, ${now},
        ${new Date(now.getTime() + hours * 3_600_000)})
      RETURNING *
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "judge.invited", subjectType: "judge_invitation", subjectId: row!.id,
      // The email is personal data: the audit keeps only a hash of it.
      details: { competitionId, emailSha256: createHash("sha256").update(email).digest("hex"), expiresAt: row!.expires_at.toISOString(), replaced: replaced.map(r => r.id) }
    });
    return { invitation: toInvitation(row!, now), token };
  });
}

export async function listInvitations(organizationId: string, competitionId: string, now = new Date()): Promise<InvitationView[]> {
  ids(organizationId, competitionId);
  const rows = await getSqlClient()<InvitationRow[]>`
    SELECT * FROM judge_invitations WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    ORDER BY created_at DESC, id LIMIT 500
  `;
  return rows.map(r => toInvitation(r, now));
}

export async function revokeInvitation(organizationId: string, competitionId: string, actorAccountId: string, invitationId: string, now = new Date()): Promise<InvitationView> {
  ids(organizationId, competitionId, actorAccountId, invitationId);
  return getSqlClient().begin(async tx => {
    const [row] = await tx<InvitationRow[]>`SELECT * FROM judge_invitations WHERE organization_id = ${organizationId}
      AND competition_id = ${competitionId} AND id = ${invitationId} FOR UPDATE`;
    if (!row) throw new DomainError("invitation_not_found");
    if (row.accepted_at) throw new DomainError("invalid_state_invitation_accepted");
    if (row.revoked_at) return toInvitation(row, now);
    const [updated] = await tx<InvitationRow[]>`UPDATE judge_invitations SET revoked_at = ${now}, revoked_by_account_id = ${actorAccountId}
      WHERE id = ${invitationId} RETURNING *`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "judge.invitation_revoked", subjectType: "judge_invitation", subjectId: invitationId, details: { competitionId } });
    return toInvitation(updated!, now);
  });
}

async function grantJudgeRole(tx: Sql, organizationId: string, competitionId: string, accountId: string, grantedBy: string): Promise<void> {
  await tx`
    INSERT INTO role_grants (account_id, role, organization_id, competition_id, granted_by_account_id)
    VALUES (${accountId}, 'judge', ${organizationId}, ${competitionId}, ${grantedBy})
    ON CONFLICT DO NOTHING
  `;
}

async function revokeJudgeRole(tx: Sql, organizationId: string, competitionId: string, accountId: string, now: Date): Promise<void> {
  await tx`UPDATE role_grants SET revoked_at = ${now} WHERE account_id = ${accountId} AND role = 'judge'
    AND organization_id = ${organizationId} AND competition_id = ${competitionId} AND revoked_at IS NULL`;
}

/**
 * Accept an invitation as the authenticated member. The account's email must equal the
 * invited email. Single use: concurrent acceptances serialize on the row lock and only one wins.
 */
export async function acceptInvitation(
  organizationId: string, competitionId: string, accountId: string, rawToken: unknown, now = new Date()
): Promise<{ judgeId: string; status: JudgeStatus }> {
  ids(organizationId, competitionId, accountId);
  const token = assertInviteToken(rawToken);
  return getSqlClient().begin(async tx => {
    const [invitation] = await tx<InvitationRow[]>`
      SELECT * FROM judge_invitations WHERE token_hash = ${hashInvitationToken(token)}
        AND organization_id = ${organizationId} AND competition_id = ${competitionId} FOR UPDATE
    `;
    if (!invitation) throw new DomainError("invitation_not_found");
    assertInvitationUsable({ acceptedAt: invitation.accepted_at, revokedAt: invitation.revoked_at, expiresAt: invitation.expires_at }, now);
    const [account] = await tx<{ email: string | null }[]>`
      SELECT a.email FROM accounts a JOIN organization_memberships m ON m.account_id = a.id
      WHERE a.id = ${accountId} AND m.organization_id = ${organizationId} AND m.status = 'active' AND a.disabled_at IS NULL
    `;
    if (!account || account.email !== invitation.email) throw new DomainError("invitation_email_mismatch");
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`judge-account:${organizationId}:${accountId}`}, 0))`;
    let [judge] = await tx<{ id: string }[]>`SELECT id FROM judges WHERE organization_id = ${organizationId} AND account_id = ${accountId}`;
    if (!judge) {
      [judge] = await tx<{ id: string }[]>`INSERT INTO judges (organization_id, display_name, account_id)
        VALUES (${organizationId}, ${invitation.display_name}, ${accountId}) RETURNING id`;
    }
    const judgeId = judge!.id;
    await tx`INSERT INTO competition_judges (organization_id, competition_id, judge_id) VALUES (${organizationId}, ${competitionId}, ${judgeId})
      ON CONFLICT (competition_id, judge_id) DO NOTHING`;
    const [state] = await tx<{ status: JudgeStatus }[]>`
      INSERT INTO competition_judge_states (organization_id, competition_id, judge_id, status, updated_by_account_id)
      VALUES (${organizationId}, ${competitionId}, ${judgeId}, 'active', ${accountId})
      ON CONFLICT (competition_id, judge_id) DO UPDATE SET
        status = CASE WHEN competition_judge_states.status = 'removed' THEN 'active' ELSE competition_judge_states.status END,
        verified_at = CASE WHEN competition_judge_states.status = 'removed' THEN NULL ELSE competition_judge_states.verified_at END,
        verified_by_account_id = CASE WHEN competition_judge_states.status = 'removed' THEN NULL ELSE competition_judge_states.verified_by_account_id END,
        revision = competition_judge_states.revision + 1, updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
      RETURNING status
    `;
    if (holdsJudgeRole(state!.status)) await grantJudgeRole(tx, organizationId, competitionId, accountId, invitation.created_by_account_id);
    await tx`UPDATE judge_invitations SET accepted_at = ${now}, accepted_account_id = ${accountId}, judge_id = ${judgeId} WHERE id = ${invitation.id}`;
    await recordAudit(tx, {
      organizationId, actorAccountId: accountId, action: "judge.invitation_accepted", subjectType: "judge", subjectId: judgeId,
      details: { competitionId, invitationId: invitation.id, status: state!.status }
    });
    return { judgeId, status: state!.status };
  });
}

export interface CompetitionJudgeView {
  judgeId: string; displayName: string; status: JudgeStatus; verifiedAt: Date | null; revision: number; linkedAccount: boolean; activeRecusals: number;
}

export async function listCompetitionJudges(organizationId: string, competitionId: string): Promise<CompetitionJudgeView[]> {
  ids(organizationId, competitionId);
  const rows = await getSqlClient()<{ judge_id: string; display_name: string; status: JudgeStatus | null; verified_at: Date | null; revision: number | null; account_id: string | null; recusals: number }[]>`
    SELECT cj.judge_id, j.display_name, s.status, s.verified_at, s.revision, j.account_id,
      (SELECT count(*)::int FROM judge_recusals r WHERE r.competition_id = cj.competition_id AND r.judge_id = cj.judge_id AND r.rescinded_at IS NULL) AS recusals
    FROM competition_judges cj
    JOIN judges j ON j.organization_id = cj.organization_id AND j.id = cj.judge_id
    LEFT JOIN competition_judge_states s ON s.competition_id = cj.competition_id AND s.judge_id = cj.judge_id
    WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${competitionId}
    ORDER BY j.display_name, cj.judge_id
  `;
  return rows.map(r => ({
    judgeId: r.judge_id, displayName: r.display_name, status: r.status ?? "active", verifiedAt: r.verified_at, revision: r.revision ?? 0,
    linkedAccount: r.account_id !== null, activeRecusals: r.recusals
  }));
}

/**
 * Producer lifecycle change: verify, suspend, reactivate or remove. Suspension and removal revoke the
 * competition-scoped judge role grant; removal also clears panel assignments. Optimistic revision.
 */
export async function updateJudgeStatus(
  organizationId: string, competitionId: string, actorAccountId: string, judgeId: string,
  input: { status: unknown; expectedRevision: unknown; reason?: unknown }, now = new Date()
): Promise<CompetitionJudgeView> {
  ids(organizationId, competitionId, actorAccountId, judgeId);
  if (!isJudgeStatus(input.status)) throw new DomainError("invalid_judge_status");
  const to = input.status;
  if (!Number.isSafeInteger(input.expectedRevision)) throw new DomainError("invalid_expected_revision");
  const reason = input.reason === undefined || input.reason === null || input.reason === "" ? null : parseRecusalReason(input.reason);
  await getSqlClient().begin(async tx => {
    const [state] = await tx<{ status: JudgeStatus; revision: number; account_id: string | null }[]>`
      SELECT s.status, s.revision, j.account_id FROM competition_judge_states s
      JOIN judges j ON j.organization_id = s.organization_id AND j.id = s.judge_id
      WHERE s.organization_id = ${organizationId} AND s.competition_id = ${competitionId} AND s.judge_id = ${judgeId}
      FOR UPDATE OF s
    `;
    if (!state) throw new DomainError("judge_not_found");
    if (state.revision !== input.expectedRevision) throw new DomainError("judge_revision_conflict");
    assertJudgeTransition(state.status, to);
    await tx`
      UPDATE competition_judge_states SET status = ${to}, revision = revision + 1, updated_by_account_id = ${actorAccountId}, updated_at = ${now},
        verified_at = ${to === "verified" ? now : to === "active" ? null : tx`verified_at`},
        verified_by_account_id = ${to === "verified" ? actorAccountId : to === "active" ? null : tx`verified_by_account_id`}
      WHERE competition_id = ${competitionId} AND judge_id = ${judgeId}
    `;
    if (state.account_id) {
      if (holdsJudgeRole(to)) await grantJudgeRole(tx, organizationId, competitionId, state.account_id, actorAccountId);
      else await revokeJudgeRole(tx, organizationId, competitionId, state.account_id, now);
    }
    if (to === "removed") {
      await tx`UPDATE round_judge_panels SET removed_at = ${now}, removed_by_account_id = ${actorAccountId}
        WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND judge_id = ${judgeId} AND removed_at IS NULL`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: `judge.${to}`, subjectType: "judge", subjectId: judgeId,
      details: { competitionId, previousStatus: state.status, reason }
    });
  });
  return (await listCompetitionJudges(organizationId, competitionId)).find(j => j.judgeId === judgeId)!;
}

export interface JudgeContext { judgeId: string; status: JudgeStatus; }

/** Resolve the judge record of an authenticated account for a competition (fails closed). */
export async function resolveJudge(tx: Sql, organizationId: string, competitionId: string, accountId: string): Promise<JudgeContext> {
  const [row] = await tx<{ judge_id: string; status: JudgeStatus }[]>`
    SELECT s.judge_id, s.status FROM judges j
    JOIN competition_judge_states s ON s.organization_id = j.organization_id AND s.judge_id = j.id
    WHERE j.organization_id = ${organizationId} AND j.account_id = ${accountId} AND s.competition_id = ${competitionId}
  `;
  if (!row) throw new DomainError("judge_not_found");
  return { judgeId: row.judge_id, status: row.status };
}

export interface PerformanceAccess { judgeId: string; roundId: string; entryId: string; panelRole: PanelRole; roundStatus: string; performanceStatus: string; }

/**
 * Access check for judge-facing reads/writes of one performance: the judge must be on the
 * round's active panel and not recused from the entry. Performances outside the judge's
 * assigned rounds are reported as not found.
 */
export async function assertPerformanceAccess(
  tx: Sql, organizationId: string, competitionId: string, accountId: string, roundId: string, performanceId: string,
  mode: "view" | "score"
): Promise<PerformanceAccess> {
  const judge = await resolveJudge(tx, organizationId, competitionId, accountId);
  if (mode === "score") assertJudgeMayScore(judge.status); else assertJudgeMayView(judge.status);
  const [row] = await tx<{ entry_id: string; panel_role: PanelRole; round_status: string; performance_status: string }[]>`
    SELECT p.entry_id, jp.panel_role, r.status AS round_status, p.status AS performance_status FROM performances p
    JOIN rounds r ON r.organization_id = p.organization_id AND r.id = p.round_id
    JOIN round_judge_panels jp ON jp.organization_id = p.organization_id AND jp.round_id = p.round_id
      AND jp.judge_id = ${judge.judgeId} AND jp.removed_at IS NULL
    WHERE p.organization_id = ${organizationId} AND p.competition_id = ${competitionId} AND p.round_id = ${roundId} AND p.id = ${performanceId}
  `;
  if (!row) throw new DomainError("performance_not_found");
  const [recusal] = await tx`SELECT 1 FROM judge_recusals WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    AND judge_id = ${judge.judgeId} AND entry_id = ${row.entry_id} AND rescinded_at IS NULL`;
  if (recusal) throw new DomainError("judge_recused");
  return { judgeId: judge.judgeId, roundId, entryId: row.entry_id, panelRole: row.panel_role, roundStatus: row.round_status, performanceStatus: row.performance_status };
}

export interface AssignmentView {
  judgeId: string; status: JudgeStatus;
  rounds: { roundId: string; label: string; ordinal: number; status: string; panelRole: PanelRole;
    performances: { performanceId: string; entryId: string; displayName: string; ordinal: number; status: string; recused: boolean }[] }[];
}

/** What a judge may see: only rounds where they sit on the active panel. */
export async function listJudgeAssignments(organizationId: string, competitionId: string, accountId: string): Promise<AssignmentView> {
  ids(organizationId, competitionId, accountId);
  const sql = getSqlClient();
  const judge = await resolveJudge(sql, organizationId, competitionId, accountId);
  assertJudgeMayView(judge.status);
  const rounds = await sql<{ id: string; label: string; ordinal: number; status: string; panel_role: PanelRole }[]>`
    SELECT r.id, r.label, r.ordinal, r.status, jp.panel_role FROM round_judge_panels jp
    JOIN rounds r ON r.organization_id = jp.organization_id AND r.id = jp.round_id
    WHERE jp.organization_id = ${organizationId} AND jp.competition_id = ${competitionId} AND jp.judge_id = ${judge.judgeId} AND jp.removed_at IS NULL
    ORDER BY r.ordinal
  `;
  const roundIds = rounds.map(r => r.id);
  const performances = roundIds.length ? await sql<{ id: string; round_id: string; entry_id: string; display_name: string; ordinal: number; status: string; recused: boolean }[]>`
    SELECT p.id, p.round_id, p.entry_id, pa.display_name, p.ordinal, p.status,
      EXISTS (SELECT 1 FROM judge_recusals x WHERE x.competition_id = p.competition_id AND x.judge_id = ${judge.judgeId}
        AND x.entry_id = p.entry_id AND x.rescinded_at IS NULL) AS recused
    FROM performances p
    JOIN entries e ON e.organization_id = p.organization_id AND e.id = p.entry_id
    JOIN participants pa ON pa.organization_id = e.organization_id AND pa.id = e.participant_id
    WHERE p.organization_id = ${organizationId} AND p.round_id = ANY(${roundIds}::uuid[])
    ORDER BY p.ordinal
  ` : [];
  return {
    judgeId: judge.judgeId, status: judge.status,
    rounds: rounds.map(r => ({
      roundId: r.id, label: r.label, ordinal: r.ordinal, status: r.status, panelRole: r.panel_role,
      performances: performances.filter(p => p.round_id === r.id).map(p => ({
        performanceId: p.id, entryId: p.entry_id, displayName: p.display_name, ordinal: p.ordinal, status: p.status, recused: p.recused
      }))
    }))
  };
}

export interface RecusalView {
  id: string; judgeId: string; entryId: string; source: "self_declared" | "producer"; reason: string;
  declaredAt: Date; rescindedAt: Date | null; rescindReason: string | null;
}

interface RecusalRow {
  id: string; judge_id: string; entry_id: string; source: RecusalView["source"]; reason: string; declared_at: Date; rescinded_at: Date | null; rescind_reason: string | null;
}
const toRecusal = (r: RecusalRow): RecusalView => ({
  id: r.id, judgeId: r.judge_id, entryId: r.entry_id, source: r.source, reason: r.reason, declaredAt: r.declared_at, rescindedAt: r.rescinded_at, rescindReason: r.rescind_reason
});

async function insertRecusal(
  tx: Sql, organizationId: string, competitionId: string, judgeId: string, entryId: string, source: RecusalView["source"], reason: string, actorAccountId: string
): Promise<RecusalView> {
  const [entry] = await tx`SELECT 1 FROM entries WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${entryId}`;
  if (!entry) throw new DomainError("entry_not_found");
  const [existing] = await tx<RecusalRow[]>`SELECT * FROM judge_recusals WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    AND judge_id = ${judgeId} AND entry_id = ${entryId} AND rescinded_at IS NULL`;
  if (existing) return toRecusal(existing);
  const [row] = await tx<RecusalRow[]>`
    INSERT INTO judge_recusals (organization_id, competition_id, judge_id, entry_id, source, reason, declared_by_account_id)
    VALUES (${organizationId}, ${competitionId}, ${judgeId}, ${entryId}, ${source}, ${reason}, ${actorAccountId})
    ON CONFLICT DO NOTHING RETURNING *
  `;
  if (!row) {
    const [raced] = await tx<RecusalRow[]>`SELECT * FROM judge_recusals WHERE competition_id = ${competitionId} AND judge_id = ${judgeId}
      AND entry_id = ${entryId} AND rescinded_at IS NULL`;
    return toRecusal(raced!);
  }
  await recordAudit(tx, {
    organizationId, actorAccountId, action: source === "self_declared" ? "judge.conflict_declared" : "judge.recused",
    subjectType: "judge", subjectId: judgeId, details: { competitionId, entryId, recusalId: row.id, reason }
  });
  return toRecusal(row);
}

/** A judge declares a conflict of interest with an entry; this recuses them immediately. Idempotent. */
export async function declareConflict(
  organizationId: string, competitionId: string, accountId: string, input: { entryId: unknown; reason: unknown }
): Promise<RecusalView> {
  ids(organizationId, competitionId, accountId);
  if (!isUuid(input.entryId)) throw new DomainError("entry_not_found");
  const reason = parseRecusalReason(input.reason);
  const entryId = input.entryId;
  return getSqlClient().begin(async tx => {
    const judge = await resolveJudge(tx, organizationId, competitionId, accountId);
    assertJudgeMayView(judge.status);
    return insertRecusal(tx, organizationId, competitionId, judge.judgeId, entryId, "self_declared", reason, accountId);
  });
}

/** Producer-imposed recusal. */
export async function recuseJudge(
  organizationId: string, competitionId: string, actorAccountId: string, input: { judgeId: unknown; entryId: unknown; reason: unknown }
): Promise<RecusalView> {
  ids(organizationId, competitionId, actorAccountId);
  if (!isUuid(input.judgeId)) throw new DomainError("judge_not_found");
  if (!isUuid(input.entryId)) throw new DomainError("entry_not_found");
  const reason = parseRecusalReason(input.reason);
  const { judgeId, entryId } = input as { judgeId: string; entryId: string };
  return getSqlClient().begin(async tx => {
    const [judge] = await tx`SELECT 1 FROM competition_judges WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND judge_id = ${judgeId}`;
    if (!judge) throw new DomainError("judge_not_found");
    return insertRecusal(tx, organizationId, competitionId, judgeId, entryId, "producer", reason, actorAccountId);
  });
}

/** Only producers lift a recusal, with a reason; the original row is kept. */
export async function rescindRecusal(
  organizationId: string, competitionId: string, actorAccountId: string, recusalId: string, reasonInput: unknown, now = new Date()
): Promise<RecusalView> {
  ids(organizationId, competitionId, actorAccountId, recusalId);
  const reason = parseRecusalReason(reasonInput);
  return getSqlClient().begin(async tx => {
    const [row] = await tx<RecusalRow[]>`
      UPDATE judge_recusals SET rescinded_at = ${now}, rescinded_by_account_id = ${actorAccountId}, rescind_reason = ${reason}
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${recusalId} AND rescinded_at IS NULL
      RETURNING *
    `;
    if (!row) throw new DomainError("recusal_not_found");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "judge.recusal_rescinded", subjectType: "judge", subjectId: row.judge_id,
      details: { competitionId, recusalId, entryId: row.entry_id, reason }
    });
    return toRecusal(row);
  });
}

export async function listRecusals(organizationId: string, competitionId: string, options: { judgeId?: string } = {}): Promise<RecusalView[]> {
  ids(organizationId, competitionId);
  if (options.judgeId !== undefined && !isUuid(options.judgeId)) throw new DomainError("invalid_query");
  const sql = getSqlClient();
  const rows = await sql<RecusalRow[]>`
    SELECT * FROM judge_recusals WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      ${options.judgeId ? sql`AND judge_id = ${options.judgeId}` : sql``}
    ORDER BY declared_at DESC, id LIMIT 500
  `;
  return rows.map(toRecusal);
}
