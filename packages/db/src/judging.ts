import {
  computeStandings, DomainError, parseContestConfig, sheetTotal, validateScores, type StandingRow
} from "@live-competition-engine/engine";
import type { TransactionSql } from "postgres";
import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";
import { lockEvent } from "./events.ts";
import { stageAudienceShares } from "./audience-voting.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireId = (value: unknown, code: string) => {
  if (typeof value !== "string" || !uuid.test(value)) throw new DomainError(400, code);
  return value;
};

/* ---------- LC-19 judges ---------- */

export interface PanelJudge { judgeId: string; accountId: string | null; displayName: string; status: string; panel: string; invitedAt: Date; respondedAt: Date | null }

export async function listPanel(organizationId: string, eventId: string): Promise<PanelJudge[]> {
  const rows = await getSqlClient()<{ judge_id: string; account_id: string | null; display_name: string; status: string; panel: string; invited_at: Date; responded_at: Date | null }[]>`
    SELECT cj.judge_id, j.account_id, j.display_name, cj.status, cj.panel, cj.invited_at, cj.responded_at
    FROM competition_judges cj JOIN judges j ON j.id = cj.judge_id AND j.organization_id = cj.organization_id
    WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${eventId} ORDER BY cj.invited_at`;
  return rows.map(r => ({ judgeId: r.judge_id, accountId: r.account_id, displayName: r.display_name, status: r.status, panel: r.panel, invitedAt: r.invited_at, respondedAt: r.responded_at }));
}

/** Producer invites an existing account (by email) to judge; the account joins the tenant but gets no judge grant until it accepts. */
export async function inviteJudge(organizationId: string, eventId: string, actorAccountId: string, email: string, displayName: unknown, panel: unknown = "main") {
  const name = typeof displayName === "string" && displayName.trim() ? displayName.trim().slice(0, 120) : null;
  const panelName = typeof panel === "string" && /^[a-z0-9_-]{1,32}$/.test(panel) ? panel : "main";
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status === "completed" || event.status === "cancelled") throw new DomainError(409, "event_closed");
    const [account] = await tx<{ id: string; email: string }[]>`SELECT id, email FROM accounts WHERE email = ${email} AND disabled_at IS NULL`;
    if (!account) throw new DomainError(404, "account_not_found");
    await tx`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${organizationId}, ${account.id}) ON CONFLICT (organization_id, account_id) DO NOTHING`;
    let [judge] = await tx<{ id: string }[]>`SELECT id FROM judges WHERE organization_id = ${organizationId} AND account_id = ${account.id}`;
    if (!judge) [judge] = await tx<{ id: string }[]>`INSERT INTO judges (organization_id, display_name, account_id) VALUES (${organizationId}, ${name ?? account.email.split("@")[0]!}, ${account.id}) RETURNING id`;
    const [row] = await tx<{ judge_id: string }[]>`
      INSERT INTO competition_judges (organization_id, competition_id, judge_id, status, panel, invited_by_account_id)
      VALUES (${organizationId}, ${eventId}, ${judge!.id}, 'invited', ${panelName}, ${actorAccountId})
      ON CONFLICT (competition_id, judge_id) DO UPDATE SET status = 'invited', panel = EXCLUDED.panel, invited_at = now(), responded_at = NULL
        WHERE competition_judges.status IN ('declined', 'removed')
      RETURNING judge_id`;
    if (!row) throw new DomainError(409, "judge_already_on_panel");
    await recordAudit(tx, { organizationId, actorAccountId, action: "judge.invited", subjectType: "judge", subjectId: judge!.id, details: { eventId, panel: panelName } });
    return { judgeId: judge!.id, accountId: account.id };
  });
}

/** The invited account accepts or declines. Accepting issues a competition-scoped judge role grant. */
export async function respondToJudgeInvite(organizationId: string, eventId: string, accountId: string, accept: boolean) {
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const [invite] = await tx<{ id: string; judge_id: string; invited_by_account_id: string }[]>`
      SELECT cj.id, cj.judge_id, cj.invited_by_account_id FROM competition_judges cj JOIN judges j ON j.id = cj.judge_id
      WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${eventId} AND j.account_id = ${accountId} AND cj.status = 'invited' FOR UPDATE OF cj`;
    if (!invite) throw new DomainError(404, "invitation_not_found");
    let grantId: string | null = null;
    if (accept) {
      const [grant] = await tx<{ id: string }[]>`
        INSERT INTO role_grants (account_id, role, organization_id, competition_id, granted_by_account_id)
        VALUES (${accountId}, 'judge', ${organizationId}, ${eventId}, ${invite.invited_by_account_id}) RETURNING id`;
      grantId = grant!.id;
    }
    await tx`UPDATE competition_judges SET status = ${accept ? "accepted" : "declined"}, responded_at = now(), role_grant_id = ${grantId} WHERE id = ${invite.id}`;
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: accept ? "judge.accepted" : "judge.declined", subjectType: "judge", subjectId: invite.judge_id, details: { eventId } });
    return { judgeId: invite.judge_id, status: accept ? "accepted" : "declined" };
  });
}

export async function removeJudge(organizationId: string, eventId: string, actorAccountId: string, judgeId: unknown, reason: unknown) {
  const id = requireId(judgeId, "invalid_judge_id");
  if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "reason_required");
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const [row] = await tx<{ role_grant_id: string | null }[]>`
      UPDATE competition_judges SET status = 'removed', responded_at = now()
      WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND judge_id = ${id} AND status IN ('invited', 'accepted')
      RETURNING role_grant_id`;
    if (!row) throw new DomainError(404, "judge_not_on_panel");
    if (row.role_grant_id) await tx`UPDATE role_grants SET revoked_at = now() WHERE id = ${row.role_grant_id} AND revoked_at IS NULL`;
    await recordAudit(tx, { organizationId, actorAccountId, action: "judge.removed", subjectType: "judge", subjectId: id, details: { eventId, reason } });
    return { judgeId: id, status: "removed" };
  });
}

/** Resolves the caller's accepted judge identity for an event, or throws 403. */
export async function judgeForAccount(tx: TransactionSql | ReturnType<typeof getSqlClient>, organizationId: string, eventId: string, accountId: string): Promise<{ judgeId: string; displayName: string }> {
  const [row] = await tx<{ judge_id: string; display_name: string }[]>`
    SELECT cj.judge_id, j.display_name FROM competition_judges cj JOIN judges j ON j.id = cj.judge_id
    WHERE cj.organization_id = ${organizationId} AND cj.competition_id = ${eventId} AND j.account_id = ${accountId} AND cj.status = 'accepted'`;
  if (!row) throw new DomainError(403, "not_an_accepted_judge");
  return { judgeId: row.judge_id, displayName: row.display_name };
}

export async function declareRecusal(organizationId: string, eventId: string, actorAccountId: string, judgeId: string, entryId: unknown, reason: unknown) {
  const entry = requireId(entryId, "invalid_entry_id");
  if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "reason_required");
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const [scored] = await tx`SELECT 1 FROM score_sheets WHERE competition_id = ${eventId} AND judge_id = ${judgeId} AND entry_id = ${entry} LIMIT 1`;
    if (scored) throw new DomainError(409, "already_scored_entry");
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO judge_recusals (organization_id, competition_id, judge_id, entry_id, reason, declared_by_account_id)
      VALUES (${organizationId}, ${eventId}, ${judgeId}, ${entry}, ${reason.trim()}, ${actorAccountId})
      ON CONFLICT (competition_id, judge_id, entry_id) DO NOTHING RETURNING id`;
    if (!row) throw new DomainError(409, "already_recused");
    await recordAudit(tx, { organizationId, actorAccountId, action: "judge.recused", subjectType: "judge", subjectId: judgeId, details: { eventId, entryId: entry } });
    return { id: row.id };
  });
}

export async function listRecusals(organizationId: string, eventId: string) {
  return getSqlClient()<{ judge_id: string; entry_id: string; reason: string; created_at: Date }[]>`
    SELECT judge_id, entry_id, reason, created_at FROM judge_recusals WHERE organization_id = ${organizationId} AND competition_id = ${eventId} ORDER BY created_at`;
}

/* ---------- LC-20 scoring ---------- */

async function lockPerformanceForScoring(tx: TransactionSql, organizationId: string, eventId: string, performanceId: string) {
  const [p] = await tx<{ id: string; entry_id: string; round_id: string; status: string; stage_status: string; ordinal: number }[]>`
    SELECT pf.id, pf.entry_id, pf.round_id, pf.status::text AS status, r.status::text AS stage_status, pf.ordinal
    FROM performances pf JOIN rounds r ON r.id = pf.round_id
    WHERE pf.organization_id = ${organizationId} AND pf.competition_id = ${eventId} AND pf.id = ${performanceId} FOR SHARE OF pf`;
  if (!p) throw new DomainError(404, "performance_not_found");
  return p;
}

async function assertScoringOpen(tx: TransactionSql, eventId: string, stageId: string) {
  const [final] = await tx`SELECT 1 FROM results WHERE competition_id = ${eventId} AND round_id = ${stageId} AND status = 'final' LIMIT 1`;
  if (final) throw new DomainError(409, "results_finalized");
}

/** A judge submits an immutable score sheet for a live or just-completed performance. */
export async function submitScores(organizationId: string, eventId: string, accountId: string, performanceId: unknown, scoresInput: unknown) {
  const pid = requireId(performanceId, "invalid_performance_id");
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    const judge = await judgeForAccount(tx, organizationId, eventId, accountId);
    const perf = await lockPerformanceForScoring(tx, organizationId, eventId, pid);
    if (perf.stage_status !== "live") throw new DomainError(409, "stage_not_live");
    if (perf.status !== "live" && perf.status !== "completed") throw new DomainError(409, "performance_not_scorable");
    await assertScoringOpen(tx, eventId, perf.round_id);
    const [recused] = await tx`SELECT 1 FROM judge_recusals WHERE competition_id = ${eventId} AND judge_id = ${judge.judgeId} AND entry_id = ${perf.entry_id}`;
    if (recused) throw new DomainError(403, "judge_recused");
    const config = parseContestConfig(event.config);
    const scores = validateScores(config.scoring.criteria, scoresInput);
    const total = sheetTotal(config.scoring.criteria, scores);
    const [row] = await tx<{ id: string; submitted_at: Date }[]>`
      INSERT INTO score_sheets (organization_id, competition_id, round_id, performance_id, entry_id, judge_id, scores, total, submitted_by_account_id)
      VALUES (${organizationId}, ${eventId}, ${perf.round_id}, ${pid}, ${perf.entry_id}, ${judge.judgeId}, ${tx.json(scores)}, ${total.toFixed(3)}, ${accountId})
      ON CONFLICT DO NOTHING RETURNING id, submitted_at`;
    if (!row) throw new DomainError(409, "already_scored");
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "score.submitted", subjectType: "score_sheet", subjectId: row.id, details: { performanceId: pid, judgeId: judge.judgeId, total: Number(total.toFixed(3)) } });
    return { id: row.id, total: Number(total.toFixed(3)), scores };
  });
}

/** A judge corrects their own sheet with a reason; the original stays immutable and is superseded. */
export async function correctScores(organizationId: string, eventId: string, accountId: string, sheetId: unknown, scoresInput: unknown, reason: unknown) {
  const sid = requireId(sheetId, "invalid_sheet_id");
  if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "correction_reason_required");
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    const judge = await judgeForAccount(tx, organizationId, eventId, accountId);
    const [sheet] = await tx<{ id: string; round_id: string; performance_id: string; entry_id: string; judge_id: string }[]>`
      SELECT s.id, s.round_id, s.performance_id, s.entry_id, s.judge_id FROM score_sheets s
      WHERE s.organization_id = ${organizationId} AND s.competition_id = ${eventId} AND s.id = ${sid}
        AND NOT EXISTS (SELECT 1 FROM score_sheets n WHERE n.supersedes_id = s.id)`;
    if (!sheet || sheet.judge_id !== judge.judgeId) throw new DomainError(404, "current_sheet_not_found");
    await assertScoringOpen(tx, eventId, sheet.round_id);
    const config = parseContestConfig(event.config);
    const scores = validateScores(config.scoring.criteria, scoresInput);
    const total = sheetTotal(config.scoring.criteria, scores);
    let row: { id: string } | undefined;
    try {
      [row] = await tx<{ id: string }[]>`
        INSERT INTO score_sheets (organization_id, competition_id, round_id, performance_id, entry_id, judge_id, scores, total, supersedes_id, correction_reason, submitted_by_account_id)
        VALUES (${organizationId}, ${eventId}, ${sheet.round_id}, ${sheet.performance_id}, ${sheet.entry_id}, ${judge.judgeId}, ${tx.json(scores)}, ${total.toFixed(3)}, ${sid}, ${reason.trim()}, ${accountId})
        RETURNING id`;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError(409, "sheet_already_corrected");
      throw error;
    }
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "score.corrected", subjectType: "score_sheet", subjectId: row!.id, details: { supersedes: sid, reason } });
    return { id: row!.id, supersedes: sid, total: Number(total.toFixed(3)) };
  });
}

export interface SheetRecord { id: string; performanceId: string; entryId: string; judgeId: string; scores: Record<string, number>; total: number; supersedesId: string | null; correctionReason: string | null; submittedAt: Date; current: boolean }

export async function listSheets(organizationId: string, eventId: string, stageId: string, judgeId?: string): Promise<SheetRecord[]> {
  const sql = getSqlClient();
  const rows = await sql<{ id: string; performance_id: string; entry_id: string; judge_id: string; scores: Record<string, number>; total: string; supersedes_id: string | null; correction_reason: string | null; submitted_at: Date; current: boolean }[]>`
    SELECT s.id, s.performance_id, s.entry_id, s.judge_id, s.scores, s.total, s.supersedes_id, s.correction_reason, s.submitted_at,
      NOT EXISTS (SELECT 1 FROM score_sheets n WHERE n.supersedes_id = s.id) AS current
    FROM score_sheets s WHERE s.organization_id = ${organizationId} AND s.competition_id = ${eventId} AND s.round_id = ${stageId}
      ${judgeId ? sql`AND s.judge_id = ${judgeId}` : sql``}
    ORDER BY s.submitted_at`;
  return rows.map(r => ({ id: r.id, performanceId: r.performance_id, entryId: r.entry_id, judgeId: r.judge_id, scores: r.scores, total: Number(r.total), supersedesId: r.supersedes_id, correctionReason: r.correction_reason, submittedAt: r.submitted_at, current: r.current }));
}

/** Audience share provider (LC-28 voting: weighted share of closed vote windows for the stage). */
export const audienceShares: { forStage: (organizationId: string, eventId: string, stageId: string) => Promise<Map<string, number>> } = {
  forStage: stageAudienceShares
};

/** Deterministic standings for a stage from current (non-superseded) sheets of accepted, non-recused judges. */
export async function stageStandings(organizationId: string, eventId: string, stageId: string): Promise<StandingRow[]> {
  const sql = getSqlClient();
  const event = (await sql<{ config: Record<string, unknown> }[]>`SELECT config FROM competitions WHERE organization_id = ${organizationId} AND id = ${eventId}`)[0];
  if (!event) throw new DomainError(404, "event_not_found");
  const config = parseContestConfig(event.config);
  const performances = await sql<{ id: string; entry_id: string; ordinal: number }[]>`
    SELECT id, entry_id, ordinal FROM performances WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND round_id = ${stageId} AND status <> 'skipped'`;
  const sheets = (await listSheets(organizationId, eventId, stageId)).filter(s => s.current);
  const panel = (await listPanel(organizationId, eventId)).filter(j => j.status === "accepted").map(j => j.judgeId);
  const recusals = await listRecusals(organizationId, eventId);
  const accepted = new Set(panel);
  const ordinal = new Map(performances.map(p => [p.id, p.ordinal]));
  const entrants = [...new Set(performances.map(p => p.entry_id))];
  const expected = new Map(entrants.map(e => [e, panel.filter(j => !recusals.some(r => r.judge_id === j && r.entry_id === e)).length]));
  const audience = config.scoring.audienceWeight > 0 ? await audienceShares.forStage(organizationId, eventId, stageId) : new Map<string, number>();
  return computeStandings(config, sheets.filter(s => accepted.has(s.judgeId)).map(s => ({ entryId: s.entryId, judgeId: s.judgeId, scores: s.scores, performanceOrdinal: ordinal.get(s.performanceId) ?? 0 })), entrants, expected, audience);
}

/* ---------- LC-21 critiques ---------- */

export interface CritiqueRecord { id: string; performanceId: string; entryId: string; judgeId: string; body: string; visibility: string; moderationStatus: string; revision: number; createdAt: Date; updatedAt: Date }
interface CritiqueRow { id: string; performance_id: string; entry_id: string; judge_id: string; body: string; visibility: string; moderation_status: string; revision: number; created_at: Date; updated_at: Date }
const toCritique = (r: CritiqueRow): CritiqueRecord => ({ id: r.id, performanceId: r.performance_id, entryId: r.entry_id, judgeId: r.judge_id, body: r.body, visibility: r.visibility, moderationStatus: r.moderation_status, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at });
const critiqueCols = "id, performance_id, entry_id, judge_id, body, visibility, moderation_status, revision, created_at, updated_at";

export async function writeCritique(organizationId: string, eventId: string, accountId: string, performanceId: unknown, body: unknown, visibility?: unknown) {
  const pid = requireId(performanceId, "invalid_performance_id");
  if (typeof body !== "string" || body.trim().length < 1 || body.length > 5000) throw new DomainError(400, "invalid_body");
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    const config = parseContestConfig(event.config);
    if (!config.critiques.enabled) throw new DomainError(409, "critiques_disabled");
    const judge = await judgeForAccount(tx, organizationId, eventId, accountId);
    const perf = await lockPerformanceForScoring(tx, organizationId, eventId, pid);
    const [recused] = await tx`SELECT 1 FROM judge_recusals WHERE competition_id = ${eventId} AND judge_id = ${judge.judgeId} AND entry_id = ${perf.entry_id}`;
    if (recused) throw new DomainError(403, "judge_recused");
    const vis = visibility === "private" || visibility === "contestant" || visibility === "public" ? visibility : config.critiques.defaultVisibility;
    const [row] = await tx.unsafe<CritiqueRow[]>(
      `INSERT INTO critiques (organization_id, competition_id, performance_id, entry_id, judge_id, body, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (performance_id, judge_id) DO NOTHING RETURNING ${critiqueCols}`,
      [organizationId, eventId, pid, perf.entry_id, judge.judgeId, body.trim(), vis]);
    if (!row) throw new DomainError(409, "critique_exists_use_revision");
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "critique.written", subjectType: "critique", subjectId: row.id, details: { visibility: vis } });
    return toCritique(row);
  });
}

async function lockCritique(tx: TransactionSql, organizationId: string, eventId: string, critiqueId: unknown) {
  const id = requireId(critiqueId, "invalid_critique_id");
  const [row] = await tx.unsafe<CritiqueRow[]>(`SELECT ${critiqueCols} FROM critiques WHERE organization_id = $1 AND competition_id = $2 AND id = $3 FOR UPDATE`, [organizationId, eventId, id]);
  if (!row) throw new DomainError(404, "critique_not_found");
  return toCritique(row);
}

/**
 * Revises a critique: the author edits body/visibility, a producer moderates (approve/hide) or
 * corrects. The prior version is preserved in `critique_revisions`.
 */
export async function reviseCritique(organizationId: string, eventId: string, actorAccountId: string, actorRole: "author" | "producer", critiqueId: unknown, expectedRevision: unknown,
  change: { body?: unknown; visibility?: unknown; moderationStatus?: unknown; reason?: unknown }) {
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const critique = await lockCritique(tx, organizationId, eventId, critiqueId);
    if (critique.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    if (actorRole === "author") {
      const judge = await judgeForAccount(tx, organizationId, eventId, actorAccountId);
      if (judge.judgeId !== critique.judgeId) throw new DomainError(404, "critique_not_found");
      if (change.moderationStatus !== undefined) throw new DomainError(403, "authors_cannot_moderate");
    }
    const body = change.body === undefined ? critique.body : change.body;
    if (typeof body !== "string" || body.trim().length < 1 || body.length > 5000) throw new DomainError(400, "invalid_body");
    const visibility = change.visibility ?? critique.visibility;
    if (!["private", "contestant", "public"].includes(visibility as string)) throw new DomainError(400, "invalid_visibility");
    const moderation = change.moderationStatus ?? (actorRole === "author" && body !== critique.body ? "pending" : critique.moderationStatus);
    if (!["pending", "approved", "hidden"].includes(moderation as string)) throw new DomainError(400, "invalid_moderation_status");
    const reason = typeof change.reason === "string" ? change.reason.trim() : null;
    if (actorRole === "producer" && change.body !== undefined && (!reason || reason.length < 3)) throw new DomainError(400, "correction_reason_required");
    await tx`INSERT INTO critique_revisions (organization_id, critique_id, revision, body, visibility, moderation_status, changed_by_account_id, change_reason)
      VALUES (${organizationId}, ${critique.id}, ${critique.revision}, ${critique.body}, ${critique.visibility}, ${critique.moderationStatus}, ${actorAccountId}, ${reason})`;
    const [row] = await tx.unsafe<CritiqueRow[]>(
      `UPDATE critiques SET body = $2, visibility = $3, moderation_status = $4, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING ${critiqueCols}`,
      [critique.id, body.trim(), visibility as string, moderation as string]);
    await recordAudit(tx, { organizationId, actorAccountId, action: actorRole === "producer" ? "critique.moderated" : "critique.revised", subjectType: "critique", subjectId: critique.id, details: { moderation, visibility, ...(reason ? { reason } : {}) } });
    return toCritique(row!);
  });
}

/**
 * Critiques visible to a viewer: producers see all; the entrant sees non-hidden contestant/public
 * critiques of their own entry; everyone sees approved public critiques.
 */
export async function visibleCritiques(organizationId: string, eventId: string, viewer: { accountId: string | null; producer: boolean }, entryId?: string): Promise<CritiqueRecord[]> {
  const sql = getSqlClient();
  const rows = await sql.unsafe<CritiqueRow[]>(
    `SELECT c.${critiqueCols.split(", ").join(", c.")} FROM critiques c
     JOIN entries e ON e.id = c.entry_id JOIN participants p ON p.id = e.participant_id
     WHERE c.organization_id = $1 AND c.competition_id = $2 ${entryId ? "AND c.entry_id = $5" : ""}
       AND ($3::boolean
         OR (c.visibility = 'public' AND c.moderation_status = 'approved')
         OR (c.visibility IN ('contestant', 'public') AND c.moderation_status <> 'hidden' AND p.account_id IS NOT NULL AND p.account_id = $4::uuid))
     ORDER BY c.created_at`,
    (entryId ? [organizationId, eventId, viewer.producer, viewer.accountId, entryId] : [organizationId, eventId, viewer.producer, viewer.accountId]) as never[]);
  return rows.map(toCritique);
}

export async function critiqueHistory(organizationId: string, critiqueId: string) {
  return getSqlClient()<{ revision: number; body: string; visibility: string; moderation_status: string; change_reason: string | null; changed_at: Date }[]>`
    SELECT revision, body, visibility, moderation_status, change_reason, changed_at FROM critique_revisions
    WHERE organization_id = ${organizationId} AND critique_id = ${critiqueId} ORDER BY revision`;
}

/** The entrant appeals a critique on their own entry (one open appeal at a time). */
export async function appealCritique(organizationId: string, eventId: string, accountId: string, critiqueId: unknown, reason: unknown) {
  if (typeof reason !== "string" || reason.trim().length < 3) throw new DomainError(400, "reason_required");
  return getSqlClient().begin(async tx => {
    const critique = await lockCritique(tx, organizationId, eventId, critiqueId);
    const [owner] = await tx`SELECT 1 FROM entries e JOIN participants p ON p.id = e.participant_id WHERE e.id = ${critique.entryId} AND p.account_id = ${accountId}`;
    if (!owner || critique.visibility === "private" || critique.moderationStatus === "hidden") throw new DomainError(404, "critique_not_found");
    try {
      const [row] = await tx<{ id: string }[]>`INSERT INTO critique_appeals (organization_id, critique_id, appellant_account_id, reason) VALUES (${organizationId}, ${critique.id}, ${accountId}, ${reason.trim()}) RETURNING id`;
      await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "critique.appealed", subjectType: "critique", subjectId: critique.id });
      return { id: row!.id, status: "open" };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError(409, "appeal_already_open");
      throw error;
    }
  });
}

export async function resolveAppeal(organizationId: string, eventId: string, actorAccountId: string, appealId: unknown, outcome: unknown, resolution: unknown) {
  const id = requireId(appealId, "invalid_appeal_id");
  if (outcome !== "upheld" && outcome !== "dismissed") throw new DomainError(400, "invalid_outcome");
  if (typeof resolution !== "string" || resolution.trim().length < 3) throw new DomainError(400, "resolution_required");
  return getSqlClient().begin(async tx => {
    const [row] = await tx<{ critique_id: string }[]>`
      UPDATE critique_appeals a SET status = ${outcome}, resolution = ${resolution.trim()}, resolved_by_account_id = ${actorAccountId}, resolved_at = now()
      FROM critiques c WHERE a.id = ${id} AND a.status = 'open' AND c.id = a.critique_id AND c.organization_id = ${organizationId} AND c.competition_id = ${eventId}
      RETURNING a.critique_id`;
    if (!row) throw new DomainError(404, "appeal_not_found");
    if (outcome === "upheld") {
      const critique = await lockCritique(tx, organizationId, eventId, row.critique_id);
      await tx`INSERT INTO critique_revisions (organization_id, critique_id, revision, body, visibility, moderation_status, changed_by_account_id, change_reason)
        VALUES (${organizationId}, ${critique.id}, ${critique.revision}, ${critique.body}, ${critique.visibility}, ${critique.moderationStatus}, ${actorAccountId}, ${`appeal upheld: ${resolution.trim()}`})`;
      await tx`UPDATE critiques SET moderation_status = 'hidden', revision = revision + 1, updated_at = now() WHERE id = ${critique.id}`;
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: `critique.appeal_${outcome}`, subjectType: "critique", subjectId: row.critique_id, details: { appealId: id } });
    return { id, status: outcome };
  });
}

export async function listAppeals(organizationId: string, eventId: string) {
  return getSqlClient()<{ id: string; critique_id: string; reason: string; status: string; resolution: string | null; created_at: Date }[]>`
    SELECT a.id, a.critique_id, a.reason, a.status, a.resolution, a.created_at FROM critique_appeals a JOIN critiques c ON c.id = a.critique_id
    WHERE c.organization_id = ${organizationId} AND c.competition_id = ${eventId} ORDER BY a.created_at`;
}
