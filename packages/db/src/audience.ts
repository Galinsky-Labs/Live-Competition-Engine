import type { FeatureKey } from "@live-competition-engine/config/features";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  AUDIENCE_LIMITS,
  assertQuestionTransition,
  canSeePollResults,
  findBlockedTerm,
  isReactionKind,
  nextChatStatus,
  nextPollStatus,
  normalizeBlockedTerm,
  normalizeChatBody,
  normalizeQuestionBody,
  normalizeReason,
  pollAcceptsVotes,
  reactionKinds,
  slowModeWaitMs,
  validateAudienceSettings,
  validateMuteSeconds,
  validatePollDefinition,
  type ChatMessageStatus,
  type ChatModerationAction,
  type PollResultsVisibility,
  type PollStatus,
  type QuestionStatus,
  type ReactionKind
} from "@live-competition-engine/domain/audience";
import { recordAudit, type Sql } from "./audit.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { consumeRateLimit, type RateLimitRule } from "./rate-limit.ts";

/** Per-account rate limits for audience writes (tenant + account + action). */
export const audienceRateLimits = {
  reaction: { limit: 30, windowMs: 10_000, mode: "sliding" },
  chat: { limit: 5, windowMs: 10_000, mode: "sliding" },
  question: { limit: 3, windowMs: 60_000, mode: "fixed" },
  upvote: { limit: 30, windowMs: 60_000, mode: "fixed" },
  pollVote: { limit: 10, windowMs: 60_000, mode: "fixed" }
} as const satisfies Record<string, RateLimitRule>;

export interface AudienceSettings {
  competitionId: string;
  termsVersion: string;
  slowModeSeconds: number;
  chatMaxLength: number;
  revision: number;
  updatedAt: Date;
}

const ids = (...values: string[]) => {
  if (!values.every(isUuid)) throw new DomainError("not_found");
};

async function ensureCompetition(sql: Sql, organizationId: string, competitionId: string): Promise<void> {
  ids(organizationId, competitionId);
  const rows = await sql`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
  if (rows.length !== 1) throw new DomainError("competition_not_found");
}

async function ensureActiveMember(sql: Sql, organizationId: string, accountId: string): Promise<void> {
  ids(accountId);
  const rows = await sql`
    SELECT 1 FROM organization_memberships
    WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND status = 'active'
  `;
  if (rows.length !== 1) throw new DomainError("forbidden");
}

/** Competition exists in tenant, account is an active member, feature is enabled for them. */
async function participantPreflight(feature: FeatureKey, organizationId: string, competitionId: string, accountId: string) {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  await ensureActiveMember(sql, organizationId, accountId);
  await requireEnabledFeature(feature, { organizationId, eventId: competitionId, accountId });
}

async function managerPreflight(feature: FeatureKey, organizationId: string, competitionId: string) {
  await ensureCompetition(getSqlClient(), organizationId, competitionId);
  await requireEnabledFeature(feature, { organizationId, eventId: competitionId });
}

const mapSettings = (row: { competition_id: string; terms_version: string; slow_mode_seconds: number; chat_max_length: number; revision: number; updated_at: Date }): AudienceSettings => ({
  competitionId: row.competition_id,
  termsVersion: row.terms_version,
  slowModeSeconds: row.slow_mode_seconds,
  chatMaxLength: row.chat_max_length,
  revision: row.revision,
  updatedAt: row.updated_at
});

export async function getAudienceSettings(organizationId: string, competitionId: string): Promise<AudienceSettings> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const [row] = await sql<Parameters<typeof mapSettings>[0][]>`
    SELECT competition_id, terms_version, slow_mode_seconds, chat_max_length, revision, updated_at
    FROM audience_settings WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
  `;
  if (!row) throw new DomainError("audience_settings_not_found");
  return mapSettings(row);
}

/** Create (expectedRevision 0) or update settings with optimistic concurrency. */
export async function updateAudienceSettings(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: Record<string, unknown>,
  expectedRevision: number
): Promise<AudienceSettings> {
  const settings = validateAudienceSettings(input);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new DomainError("invalid_revision");
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  return sql.begin(async tx => {
    const rows = expectedRevision === 0
      ? await tx<Parameters<typeof mapSettings>[0][]>`
          INSERT INTO audience_settings (organization_id, competition_id, terms_version, slow_mode_seconds, chat_max_length, updated_by_account_id)
          VALUES (${organizationId}, ${competitionId}, ${settings.termsVersion}, ${settings.slowModeSeconds}, ${settings.chatMaxLength}, ${actorAccountId})
          ON CONFLICT (organization_id, competition_id) DO NOTHING
          RETURNING competition_id, terms_version, slow_mode_seconds, chat_max_length, revision, updated_at`
      : await tx<Parameters<typeof mapSettings>[0][]>`
          UPDATE audience_settings SET terms_version = ${settings.termsVersion},
            slow_mode_seconds = ${settings.slowModeSeconds}, chat_max_length = ${settings.chatMaxLength},
            revision = revision + 1, updated_by_account_id = ${actorAccountId}, updated_at = now()
          WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND revision = ${expectedRevision}
          RETURNING competition_id, terms_version, slow_mode_seconds, chat_max_length, revision, updated_at`;
    const row = rows[0];
    if (!row) throw new DomainError("revision_conflict");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.settings_updated", subjectType: "competition",
      subjectId: competitionId, details: { ...settings, revision: row.revision }
    });
    return mapSettings(row);
  });
}

/** Record explicit acceptance of the competition's CURRENT audience terms version. */
export async function acceptAudienceTerms(
  organizationId: string,
  competitionId: string,
  accountId: string,
  termsVersion: unknown
): Promise<{ termsVersion: string; acceptedAt: Date }> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  await ensureActiveMember(sql, organizationId, accountId);
  return sql.begin(async tx => {
    const [settings] = await tx<{ terms_version: string }[]>`
      SELECT terms_version FROM audience_settings
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} FOR SHARE
    `;
    if (!settings) throw new DomainError("audience_settings_not_found");
    if (termsVersion !== settings.terms_version) throw new DomainError("terms_version_mismatch");
    await tx`
      INSERT INTO audience_consents (organization_id, competition_id, account_id, terms_version)
      VALUES (${organizationId}, ${competitionId}, ${accountId}, ${settings.terms_version})
      ON CONFLICT DO NOTHING
    `;
    const [row] = await tx<{ accepted_at: Date }[]>`
      SELECT accepted_at FROM audience_consents
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
        AND account_id = ${accountId} AND terms_version = ${settings.terms_version}
    `;
    return { termsVersion: settings.terms_version, acceptedAt: row!.accepted_at };
  });
}

/** Inside a write transaction: settings exist and the account accepted the current terms. */
async function requireConsent(tx: Sql, organizationId: string, competitionId: string, accountId: string) {
  const [row] = await tx<(Parameters<typeof mapSettings>[0] & { consented: boolean })[]>`
    SELECT s.competition_id, s.terms_version, s.slow_mode_seconds, s.chat_max_length, s.revision, s.updated_at,
      EXISTS (
        SELECT 1 FROM audience_consents c
        WHERE c.organization_id = s.organization_id AND c.competition_id = s.competition_id
          AND c.account_id = ${accountId} AND c.terms_version = s.terms_version
      ) AS consented
    FROM audience_settings s
    WHERE s.organization_id = ${organizationId} AND s.competition_id = ${competitionId}
    FOR SHARE OF s
  `;
  if (!row) throw new DomainError("audience_settings_not_found");
  if (!row.consented) throw new DomainError("consent_required");
  return mapSettings(row);
}

// ---------------------------------------------------------------- reactions

export type ReactionCounts = Record<ReactionKind, number>;

async function readReactionCounts(sql: Sql, organizationId: string, competitionId: string, performanceId: string): Promise<ReactionCounts> {
  const rows = await sql<{ kind: ReactionKind; count: string }[]>`
    SELECT kind, count::text FROM audience_reaction_counts
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND performance_id = ${performanceId}
  `;
  const counts = Object.fromEntries(reactionKinds.map(kind => [kind, 0])) as ReactionCounts;
  for (const row of rows) counts[row.kind] = Number(row.count);
  return counts;
}

export async function addReaction(
  organizationId: string,
  competitionId: string,
  performanceId: string,
  accountId: string,
  kind: unknown,
  now: Date = new Date()
): Promise<ReactionCounts> {
  if (!isReactionKind(kind)) throw new DomainError("invalid_reaction");
  ids(performanceId);
  await participantPreflight("reactions", organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const performance = await tx`
      SELECT 1 FROM performances WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${performanceId}
    `;
    if (performance.length !== 1) throw new DomainError("performance_not_found");
    await requireConsent(tx, organizationId, competitionId, accountId);
    await consumeRateLimit(tx, { organizationId, accountId, action: "audience.reaction" }, audienceRateLimits.reaction, now);
    await tx`
      INSERT INTO audience_reaction_counts (organization_id, competition_id, performance_id, kind, count, updated_at)
      VALUES (${organizationId}, ${competitionId}, ${performanceId}, ${kind}, 1, ${now})
      ON CONFLICT (organization_id, competition_id, performance_id, kind)
      DO UPDATE SET count = audience_reaction_counts.count + 1, updated_at = ${now}
    `;
    return readReactionCounts(tx, organizationId, competitionId, performanceId);
  });
}

export async function getReactionCounts(organizationId: string, competitionId: string, performanceId: string): Promise<ReactionCounts> {
  ids(performanceId);
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  return readReactionCounts(sql, organizationId, competitionId, performanceId);
}

// ---------------------------------------------------------------- chat

export interface ChatMessage {
  id: string;
  accountId: string;
  body: string | null;
  status: ChatMessageStatus;
  createdAt: Date;
  moderationReason?: string | null;
}

async function activeTerms(sql: Sql, organizationId: string): Promise<string[]> {
  const rows = await sql<{ term: string }[]>`
    SELECT term FROM audience_blocked_terms WHERE organization_id = ${organizationId} ORDER BY term LIMIT ${AUDIENCE_LIMITS.blockedTermsPerTenant}
  `;
  return rows.map(row => row.term);
}

async function assertNotMuted(tx: Sql, organizationId: string, competitionId: string, accountId: string, now: Date) {
  const muted = await tx`
    SELECT 1 FROM chat_mutes
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND account_id = ${accountId}
      AND revoked_at IS NULL AND muted_until > ${now}
    LIMIT 1
  `;
  if (muted.length > 0) throw new DomainError("account_muted");
}

export async function postChatMessage(
  organizationId: string,
  competitionId: string,
  accountId: string,
  rawBody: unknown,
  now: Date = new Date()
): Promise<ChatMessage> {
  await participantPreflight("chat", organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const settings = await requireConsent(tx, organizationId, competitionId, accountId);
    const body = normalizeChatBody(rawBody, settings.chatMaxLength);
    await assertNotMuted(tx, organizationId, competitionId, accountId, now);
    if (findBlockedTerm(body, await activeTerms(tx, organizationId))) throw new DomainError("message_blocked");
    // Serialize one account's posts in this competition so slow mode cannot be raced.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`chat:${competitionId}:${accountId}`}, 0))`;
    if (settings.slowModeSeconds > 0) {
      const [last] = await tx<{ created_at: Date }[]>`
        SELECT created_at FROM chat_messages
        WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND account_id = ${accountId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (slowModeWaitMs(last?.created_at ?? null, now, settings.slowModeSeconds) > 0) throw new DomainError("rate_limited");
    }
    await consumeRateLimit(tx, { organizationId, accountId, action: "audience.chat" }, audienceRateLimits.chat, now);
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO chat_messages (organization_id, competition_id, account_id, body, created_at)
      VALUES (${organizationId}, ${competitionId}, ${accountId}, ${body}, ${now})
      RETURNING id, created_at
    `;
    return { id: row!.id, accountId, body, status: "visible" as const, createdAt: row!.created_at };
  });
}

export async function listChatMessages(
  organizationId: string,
  competitionId: string,
  options: { includeModerated?: boolean; limit?: number; before?: Date } = {}
): Promise<ChatMessage[]> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await sql<{ id: string; account_id: string; body: string | null; status: ChatMessageStatus; created_at: Date; moderation_reason: string | null }[]>`
    SELECT id, account_id, body, status, created_at, moderation_reason FROM chat_messages
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      ${options.includeModerated ? sql`` : sql`AND status = 'visible'`}
      ${options.before ? sql`AND created_at < ${options.before}` : sql``}
    ORDER BY created_at DESC, id DESC LIMIT ${limit}
  `;
  return rows.map(row => ({
    id: row.id, accountId: row.account_id, body: row.body, status: row.status, createdAt: row.created_at,
    ...(options.includeModerated ? { moderationReason: row.moderation_reason } : {})
  }));
}

export async function moderateChatMessage(
  organizationId: string,
  competitionId: string,
  messageId: string,
  actorAccountId: string,
  action: unknown,
  rawReason: unknown
): Promise<ChatMessage> {
  if (action !== "hide" && action !== "unhide" && action !== "delete") throw new DomainError("invalid_action");
  const reason = normalizeReason(rawReason);
  ids(messageId);
  await managerPreflight("chat", organizationId, competitionId);
  return getSqlClient().begin(async tx => {
    const [row] = await tx<{ id: string; account_id: string; status: ChatMessageStatus; created_at: Date }[]>`
      SELECT id, account_id, status, created_at FROM chat_messages
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${messageId}
      FOR UPDATE
    `;
    if (!row) throw new DomainError("message_not_found");
    const next = nextChatStatus(row.status, action as ChatModerationAction);
    const [updated] = await tx<{ body: string | null }[]>`
      UPDATE chat_messages SET status = ${next},
        body = CASE WHEN ${next} = 'deleted' THEN NULL ELSE body END,
        moderated_by_account_id = ${actorAccountId}, moderated_at = now(), moderation_reason = ${reason}
      WHERE organization_id = ${organizationId} AND id = ${messageId}
      RETURNING body
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.chat_moderated", subjectType: "chat_message", subjectId: messageId,
      details: { competitionId, from: row.status, to: next, reason, authorAccountId: row.account_id }
    });
    return { id: row.id, accountId: row.account_id, body: updated!.body, status: next, createdAt: row.created_at, moderationReason: reason };
  });
}

export async function muteAccount(
  organizationId: string,
  competitionId: string,
  targetAccountId: string,
  actorAccountId: string,
  durationSeconds: unknown,
  rawReason: unknown,
  now: Date = new Date()
): Promise<{ id: string; mutedUntil: Date }> {
  const seconds = validateMuteSeconds(durationSeconds);
  const reason = normalizeReason(rawReason)!;
  ids(targetAccountId);
  await managerPreflight("chat", organizationId, competitionId);
  return getSqlClient().begin(async tx => {
    const member = await tx`SELECT 1 FROM organization_memberships WHERE organization_id = ${organizationId} AND account_id = ${targetAccountId}`;
    if (member.length !== 1) throw new DomainError("account_not_found");
    const mutedUntil = new Date(now.getTime() + seconds * 1000);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO chat_mutes (organization_id, competition_id, account_id, muted_until, reason, created_by_account_id, created_at)
      VALUES (${organizationId}, ${competitionId}, ${targetAccountId}, ${mutedUntil}, ${reason}, ${actorAccountId}, ${now})
      RETURNING id
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.account_muted", subjectType: "account", subjectId: targetAccountId,
      details: { competitionId, muteId: row!.id, mutedUntil: mutedUntil.toISOString(), reason }
    });
    return { id: row!.id, mutedUntil };
  });
}

export async function revokeMute(organizationId: string, competitionId: string, muteId: string, actorAccountId: string): Promise<void> {
  ids(muteId);
  await ensureCompetition(getSqlClient(), organizationId, competitionId);
  await getSqlClient().begin(async tx => {
    const rows = await tx<{ account_id: string }[]>`
      UPDATE chat_mutes SET revoked_at = now()
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${muteId} AND revoked_at IS NULL
      RETURNING account_id
    `;
    if (!rows[0]) throw new DomainError("mute_not_found");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.mute_revoked", subjectType: "account", subjectId: rows[0].account_id,
      details: { competitionId, muteId }
    });
  });
}

// ---------------------------------------------------------------- blocked terms

export async function listBlockedTerms(organizationId: string): Promise<{ id: string; term: string; createdAt: Date }[]> {
  ids(organizationId);
  const rows = await getSqlClient()<{ id: string; term: string; created_at: Date }[]>`
    SELECT id, term, created_at FROM audience_blocked_terms WHERE organization_id = ${organizationId} ORDER BY term
  `;
  return rows.map(row => ({ id: row.id, term: row.term, createdAt: row.created_at }));
}

export async function addBlockedTerm(organizationId: string, actorAccountId: string, rawTerm: unknown): Promise<{ id: string; term: string }> {
  ids(organizationId);
  const term = normalizeBlockedTerm(rawTerm);
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`blocked-terms:${organizationId}`}, 0))`;
    const [counted] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total FROM audience_blocked_terms WHERE organization_id = ${organizationId}
    `;
    const total = counted!.total;
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM audience_blocked_terms WHERE organization_id = ${organizationId} AND term = ${term}
    `;
    if (existing) return { id: existing.id, term };
    if (total >= AUDIENCE_LIMITS.blockedTermsPerTenant) throw new DomainError("blocked_term_limit_reached");
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO audience_blocked_terms (organization_id, term, created_by_account_id)
      VALUES (${organizationId}, ${term}, ${actorAccountId}) RETURNING id
    `;
    // The term itself is not copied into the audit log; the id identifies it.
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.blocked_term_added", subjectType: "blocked_term", subjectId: row!.id
    });
    return { id: row!.id, term };
  });
}

export async function removeBlockedTerm(organizationId: string, actorAccountId: string, termId: string): Promise<void> {
  ids(organizationId, termId);
  await getSqlClient().begin(async tx => {
    const rows = await tx`DELETE FROM audience_blocked_terms WHERE organization_id = ${organizationId} AND id = ${termId} RETURNING id`;
    if (rows.length !== 1) throw new DomainError("blocked_term_not_found");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.blocked_term_removed", subjectType: "blocked_term", subjectId: termId
    });
  });
}

// ---------------------------------------------------------------- questions

export interface AudienceQuestion {
  id: string;
  body: string;
  status: QuestionStatus;
  upvoteCount: number;
  createdAt: Date;
  mine?: boolean;
}

export async function submitQuestion(
  organizationId: string,
  competitionId: string,
  accountId: string,
  rawBody: unknown,
  now: Date = new Date()
): Promise<AudienceQuestion> {
  const body = normalizeQuestionBody(rawBody);
  await participantPreflight("questions", organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    await requireConsent(tx, organizationId, competitionId, accountId);
    await assertNotMuted(tx, organizationId, competitionId, accountId, now);
    if (findBlockedTerm(body, await activeTerms(tx, organizationId))) throw new DomainError("message_blocked");
    await consumeRateLimit(tx, { organizationId, accountId, action: "audience.question" }, audienceRateLimits.question, now);
    const [row] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO audience_questions (organization_id, competition_id, account_id, body, created_at)
      VALUES (${organizationId}, ${competitionId}, ${accountId}, ${body}, ${now}) RETURNING id, created_at
    `;
    return { id: row!.id, body, status: "open" as const, upvoteCount: 0, createdAt: row!.created_at, mine: true };
  });
}

/** Upvote once per account. Repeating is a no-op that returns `counted: false`. */
export async function upvoteQuestion(
  organizationId: string,
  competitionId: string,
  questionId: string,
  accountId: string,
  now: Date = new Date()
): Promise<{ upvoteCount: number; counted: boolean }> {
  ids(questionId);
  await participantPreflight("questions", organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    await requireConsent(tx, organizationId, competitionId, accountId);
    const [question] = await tx<{ status: QuestionStatus; upvote_count: number }[]>`
      SELECT status, upvote_count FROM audience_questions
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${questionId}
      FOR UPDATE
    `;
    if (!question) throw new DomainError("question_not_found");
    if (question.status !== "open") throw new DomainError("invalid_state_question_closed");
    await consumeRateLimit(tx, { organizationId, accountId, action: "audience.upvote" }, audienceRateLimits.upvote, now);
    const inserted = await tx`
      INSERT INTO audience_question_upvotes (organization_id, question_id, account_id, created_at)
      VALUES (${organizationId}, ${questionId}, ${accountId}, ${now}) ON CONFLICT DO NOTHING RETURNING 1
    `;
    if (inserted.length === 0) return { upvoteCount: question.upvote_count, counted: false };
    const [row] = await tx<{ upvote_count: number }[]>`
      UPDATE audience_questions SET upvote_count = upvote_count + 1
      WHERE organization_id = ${organizationId} AND id = ${questionId} RETURNING upvote_count
    `;
    return { upvoteCount: row!.upvote_count, counted: true };
  });
}

export async function decideQuestion(
  organizationId: string,
  competitionId: string,
  questionId: string,
  actorAccountId: string,
  status: unknown
): Promise<AudienceQuestion> {
  if (status !== "answered" && status !== "dismissed") throw new DomainError("invalid_status");
  ids(questionId);
  await managerPreflight("questions", organizationId, competitionId);
  return getSqlClient().begin(async tx => {
    const [question] = await tx<{ status: QuestionStatus }[]>`
      SELECT status FROM audience_questions
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${questionId}
      FOR UPDATE
    `;
    if (!question) throw new DomainError("question_not_found");
    assertQuestionTransition(question.status, status);
    const [row] = await tx<{ id: string; body: string; status: QuestionStatus; upvote_count: number; created_at: Date }[]>`
      UPDATE audience_questions SET status = ${status}, decided_by_account_id = ${actorAccountId}, decided_at = now()
      WHERE organization_id = ${organizationId} AND id = ${questionId}
      RETURNING id, body, status, upvote_count, created_at
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.question_decided", subjectType: "audience_question", subjectId: questionId,
      details: { competitionId, from: question.status, to: status }
    });
    return { id: row!.id, body: row!.body, status: row!.status, upvoteCount: row!.upvote_count, createdAt: row!.created_at };
  });
}

export async function listQuestions(
  organizationId: string,
  competitionId: string,
  options: { status?: QuestionStatus; viewerAccountId?: string; limit?: number } = {}
): Promise<AudienceQuestion[]> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  if (options.status && !["open", "answered", "dismissed"].includes(options.status)) throw new DomainError("invalid_status");
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const rows = await sql<{ id: string; body: string; status: QuestionStatus; upvote_count: number; created_at: Date; account_id: string }[]>`
    SELECT id, body, status, upvote_count, created_at, account_id FROM audience_questions
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      ${options.status ? sql`AND status = ${options.status}` : sql``}
    ORDER BY upvote_count DESC, created_at ASC, id ASC LIMIT ${limit}
  `;
  return rows.map(row => ({
    id: row.id, body: row.body, status: row.status, upvoteCount: row.upvote_count, createdAt: row.created_at,
    mine: options.viewerAccountId === row.account_id
  }));
}

// ---------------------------------------------------------------- polls

export interface PollView {
  id: string;
  question: string;
  status: PollStatus;
  resultsVisibility: PollResultsVisibility;
  closesAt: Date | null;
  acceptingVotes: boolean;
  revision: number;
  options: { id: string; ordinal: number; label: string }[];
  results: { optionId: string; votes: number }[] | null;
  totalVotes: number | null;
  myOptionId?: string | null;
}

export async function createPoll(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: Record<string, unknown>,
  now: Date = new Date()
): Promise<PollView> {
  const definition = validatePollDefinition(input, now);
  await managerPreflight("polls", organizationId, competitionId);
  const pollId = await getSqlClient().begin(async tx => {
    const [poll] = await tx<{ id: string }[]>`
      INSERT INTO audience_polls (organization_id, competition_id, question, results_visibility, closes_at, created_by_account_id, created_at)
      VALUES (${organizationId}, ${competitionId}, ${definition.question}, ${definition.resultsVisibility}, ${definition.closesAt}, ${actorAccountId}, ${now})
      RETURNING id
    `;
    for (const [index, label] of definition.options.entries()) {
      await tx`INSERT INTO audience_poll_options (organization_id, poll_id, ordinal, label) VALUES (${organizationId}, ${poll!.id}, ${index + 1}, ${label})`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "audience.poll_created", subjectType: "audience_poll", subjectId: poll!.id,
      details: { competitionId, optionCount: definition.options.length, resultsVisibility: definition.resultsVisibility }
    });
    return poll!.id;
  });
  return getPoll(organizationId, competitionId, pollId, { isManager: true, now });
}

export async function transitionPoll(
  organizationId: string,
  competitionId: string,
  pollId: string,
  actorAccountId: string,
  action: unknown,
  expectedRevision: unknown,
  now: Date = new Date()
): Promise<PollView> {
  if (action !== "open" && action !== "close") throw new DomainError("invalid_action");
  if (!Number.isInteger(expectedRevision)) throw new DomainError("invalid_revision");
  ids(pollId);
  await managerPreflight("polls", organizationId, competitionId);
  await getSqlClient().begin(async tx => {
    const [poll] = await tx<{ status: PollStatus; revision: number }[]>`
      SELECT status, revision FROM audience_polls
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${pollId}
      FOR UPDATE
    `;
    if (!poll) throw new DomainError("poll_not_found");
    if (poll.revision !== expectedRevision) throw new DomainError("revision_conflict");
    const next = nextPollStatus(poll.status, action);
    await tx`
      UPDATE audience_polls SET status = ${next}, revision = revision + 1,
        opened_at = CASE WHEN ${next} = 'open' THEN ${now}::timestamptz ELSE opened_at END,
        closed_at = CASE WHEN ${next} = 'closed' THEN ${now}::timestamptz ELSE closed_at END
      WHERE organization_id = ${organizationId} AND id = ${pollId}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: next === "open" ? "audience.poll_opened" : "audience.poll_closed",
      subjectType: "audience_poll", subjectId: pollId, details: { competitionId, from: poll.status, to: next }
    });
  });
  return getPoll(organizationId, competitionId, pollId, { isManager: true, now });
}

export async function votePoll(
  organizationId: string,
  competitionId: string,
  pollId: string,
  accountId: string,
  optionId: unknown,
  now: Date = new Date()
): Promise<{ pollId: string; optionId: string }> {
  ids(pollId);
  if (!isUuid(optionId)) throw new DomainError("invalid_option");
  await participantPreflight("polls", organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    await requireConsent(tx, organizationId, competitionId, accountId);
    const [poll] = await tx<{ status: PollStatus; closes_at: Date | null }[]>`
      SELECT status, closes_at FROM audience_polls
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${pollId}
      FOR SHARE
    `;
    if (!poll) throw new DomainError("poll_not_found");
    if (!pollAcceptsVotes(poll.status, poll.closes_at, now)) throw new DomainError("invalid_state_poll_not_open");
    const option = await tx`SELECT 1 FROM audience_poll_options WHERE organization_id = ${organizationId} AND poll_id = ${pollId} AND id = ${optionId}`;
    if (option.length !== 1) throw new DomainError("invalid_option");
    await consumeRateLimit(tx, { organizationId, accountId, action: "audience.poll_vote" }, audienceRateLimits.pollVote, now);
    const inserted = await tx`
      INSERT INTO audience_poll_votes (organization_id, poll_id, account_id, option_id, created_at)
      VALUES (${organizationId}, ${pollId}, ${accountId}, ${optionId}, ${now})
      ON CONFLICT (organization_id, poll_id, account_id) DO NOTHING RETURNING 1
    `;
    if (inserted.length === 0) throw new DomainError("vote_conflict");
    return { pollId, optionId };
  });
}

export async function getPoll(
  organizationId: string,
  competitionId: string,
  pollId: string,
  viewer: { isManager: boolean; accountId?: string; now?: Date }
): Promise<PollView> {
  ids(pollId);
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const [poll] = await sql<{ id: string; question: string; status: PollStatus; results_visibility: PollResultsVisibility; closes_at: Date | null; revision: number }[]>`
    SELECT id, question, status, results_visibility, closes_at, revision FROM audience_polls
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${pollId}
  `;
  if (!poll) throw new DomainError("poll_not_found");
  if (poll.status === "draft" && !viewer.isManager) throw new DomainError("poll_not_found");
  const now = viewer.now ?? new Date();
  const options = await sql<{ id: string; ordinal: number; label: string }[]>`
    SELECT id, ordinal, label FROM audience_poll_options WHERE organization_id = ${organizationId} AND poll_id = ${pollId} ORDER BY ordinal
  `;
  const visible = canSeePollResults(poll.results_visibility, poll.status, poll.closes_at, now, viewer.isManager);
  let results: PollView["results"] = null;
  let totalVotes: number | null = null;
  if (visible) {
    const counts = await sql<{ option_id: string; votes: number }[]>`
      SELECT option_id, count(*)::int AS votes FROM audience_poll_votes
      WHERE organization_id = ${organizationId} AND poll_id = ${pollId} GROUP BY option_id
    `;
    const byOption = new Map(counts.map(row => [row.option_id, row.votes]));
    results = options.map(option => ({ optionId: option.id, votes: byOption.get(option.id) ?? 0 }));
    totalVotes = results.reduce((sum, row) => sum + row.votes, 0);
  }
  let myOptionId: string | null | undefined;
  if (viewer.accountId) {
    const [mine] = await sql<{ option_id: string }[]>`
      SELECT option_id FROM audience_poll_votes WHERE organization_id = ${organizationId} AND poll_id = ${pollId} AND account_id = ${viewer.accountId}
    `;
    myOptionId = mine?.option_id ?? null;
  }
  return {
    id: poll.id, question: poll.question, status: poll.status, resultsVisibility: poll.results_visibility,
    closesAt: poll.closes_at, acceptingVotes: pollAcceptsVotes(poll.status, poll.closes_at, now), revision: poll.revision,
    options: options.map(option => ({ id: option.id, ordinal: option.ordinal, label: option.label })),
    results, totalVotes, ...(myOptionId !== undefined ? { myOptionId } : {})
  };
}

export async function listPolls(
  organizationId: string,
  competitionId: string,
  viewer: { isManager: boolean; accountId?: string; now?: Date }
): Promise<PollView[]> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM audience_polls
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      ${viewer.isManager ? sql`` : sql`AND status <> 'draft'`}
    ORDER BY created_at DESC, id LIMIT 50
  `;
  const polls: PollView[] = [];
  for (const row of rows) polls.push(await getPoll(organizationId, competitionId, row.id, viewer));
  return polls;
}
