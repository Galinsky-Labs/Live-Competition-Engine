import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  BACKSTAGE_LIMITS,
  assertCanPost,
  assertReadiness,
  assertWithinRate,
  canViewMessage,
  normalizeBody,
  type BackstageKind,
  type BackstageRole,
  type Readiness
} from "@live-competition-engine/domain/backstage";
import { getSqlClient } from "./index.ts";
import { recordAudit, type Sql } from "./audit.ts";
import { assertCompetitionInTenant, isUniqueViolation, lockChannel } from "./live-common.ts";
import { assertIdempotencyKey } from "./streams.ts";

export interface BackstageAuthor {
  accountId: string;
  role: BackstageRole;
}

export interface BackstageMessage {
  id: string;
  seq: number;
  kind: BackstageKind;
  performanceId: string | null;
  entryId: string | null;
  readiness: Readiness | null;
  body: string;
  refSeq: number | null;
  authorRole: BackstageRole;
  /** Only disclosed to producers; others see `mine`. */
  authorAccountId?: string;
  mine: boolean;
  createdAt: string;
}

interface MessageRow {
  id: string; seq: string; kind: BackstageKind; performance_id: string | null; entry_id: string | null;
  readiness: Readiness | null; body: string; ref_seq: string | null; author_account_id: string;
  author_role: BackstageRole; created_at: Date;
}

const toMessage = (row: MessageRow, viewer: BackstageAuthor): BackstageMessage => ({
  id: row.id,
  seq: Number(row.seq),
  kind: row.kind,
  performanceId: row.performance_id,
  entryId: row.entry_id,
  readiness: row.readiness,
  body: row.body,
  refSeq: row.ref_seq === null ? null : Number(row.ref_seq),
  authorRole: row.author_role,
  ...(viewer.role === "producer" ? { authorAccountId: row.author_account_id } : {}),
  mine: row.author_account_id === viewer.accountId,
  createdAt: row.created_at.toISOString()
});

const messageColumns = (sql: Sql) => sql`
  id, seq::text, kind, performance_id, entry_id, readiness, body, ref_seq::text, author_account_id, author_role, created_at
`;

export async function listLinkedEntryIds(organizationId: string, competitionId: string, accountId: string, sql: Sql = getSqlClient()): Promise<string[]> {
  const rows = await sql<{ entry_id: string }[]>`
    SELECT entry_id FROM backstage_entry_accounts
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND account_id = ${accountId}
  `;
  return rows.map(row => row.entry_id);
}

/** Producer links (or unlinks) a tenant member as the backstage voice of an entry. */
export async function setEntryAccountLink(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  input: { entryId: string; accountId: string; linked: boolean }
): Promise<{ entryId: string; accountId: string; linked: boolean }> {
  if (!isUuid(input.entryId) || !isUuid(input.accountId) || typeof input.linked !== "boolean") throw new DomainError("invalid_input");
  return getSqlClient().begin(async tx => {
    await assertCompetitionInTenant(tx, organizationId, competitionId);
    const [entry] = await tx`SELECT 1 FROM entries WHERE organization_id = ${organizationId}
      AND competition_id = ${competitionId} AND id = ${input.entryId}`;
    if (!entry) throw new DomainError("entry_not_found");
    if (input.linked) {
      const [member] = await tx`SELECT 1 FROM organization_memberships WHERE organization_id = ${organizationId}
        AND account_id = ${input.accountId} AND status = 'active'`;
      if (!member) throw new DomainError("account_not_found");
      await tx`INSERT INTO backstage_entry_accounts (organization_id, competition_id, entry_id, account_id, linked_by_account_id)
        VALUES (${organizationId}, ${competitionId}, ${input.entryId}, ${input.accountId}, ${actorAccountId})
        ON CONFLICT DO NOTHING`;
    } else {
      await tx`DELETE FROM backstage_entry_accounts WHERE organization_id = ${organizationId}
        AND entry_id = ${input.entryId} AND account_id = ${input.accountId}`;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: input.linked ? "backstage.entry_linked" : "backstage.entry_unlinked",
      subjectType: "entry", subjectId: input.entryId, details: { accountId: input.accountId, competitionId }
    });
    return input;
  });
}

interface AppendInput {
  kind: BackstageKind;
  performanceId?: string | null;
  entryId?: string | null;
  readiness?: Readiness | null;
  body: string;
  refSeq?: number | null;
  idempotencyKey: string;
}

async function append(
  organizationId: string,
  competitionId: string,
  author: BackstageAuthor,
  input: AppendInput,
  validate?: (tx: Sql) => Promise<Partial<AppendInput>>
): Promise<BackstageMessage> {
  assertCanPost(author.role, input.kind);
  assertIdempotencyKey(input.idempotencyKey);
  const sql = getSqlClient();
  const replay = async () => {
    const [row] = await sql<MessageRow[]>`SELECT ${messageColumns(sql)} FROM backstage_messages
      WHERE organization_id = ${organizationId} AND idempotency_key = ${input.idempotencyKey}`;
    if (!row) return null;
    if (row.author_account_id !== author.accountId || row.kind !== input.kind) throw new DomainError("idempotency_conflict");
    return toMessage(row, author);
  };
  const existing = await replay();
  if (existing) return existing;
  try {
    return await sql.begin(async tx => {
      await assertCompetitionInTenant(tx, organizationId, competitionId);
      const resolved = { ...input, ...(validate ? await validate(tx) : {}) };
      await lockChannel(tx, "backstage", organizationId, competitionId);
      const [recent] = await tx<{ count: string }[]>`SELECT count(*)::text AS count FROM backstage_messages
        WHERE competition_id = ${competitionId} AND author_account_id = ${author.accountId}
          AND created_at > now() - make_interval(secs => ${BACKSTAGE_LIMITS.rateWindowMs / 1000})`;
      assertWithinRate(Number(recent!.count));
      const [head] = await tx<{ seq: string }[]>`SELECT COALESCE(max(seq), 0)::text AS seq FROM backstage_messages
        WHERE competition_id = ${competitionId}`;
      const seq = Number(head!.seq) + 1;
      const [row] = await tx<MessageRow[]>`
        INSERT INTO backstage_messages (organization_id, competition_id, seq, kind, performance_id, entry_id,
          readiness, body, ref_seq, author_account_id, author_role, idempotency_key)
        VALUES (${organizationId}, ${competitionId}, ${seq}, ${resolved.kind}, ${resolved.performanceId ?? null},
          ${resolved.entryId ?? null}, ${resolved.readiness ?? null}, ${resolved.body}, ${resolved.refSeq ?? null},
          ${author.accountId}, ${author.role}, ${input.idempotencyKey})
        RETURNING ${messageColumns(tx)}
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId: author.accountId, action: `backstage.${resolved.kind}`,
        subjectType: "backstage_message", subjectId: row!.id,
        details: {
          competitionId, seq, role: author.role,
          ...(resolved.performanceId ? { performanceId: resolved.performanceId } : {}),
          ...(resolved.readiness ? { readiness: resolved.readiness } : {}),
          ...(resolved.refSeq ? { refSeq: resolved.refSeq } : {})
        }
      });
      return toMessage(row!, author);
    });
  } catch (error) {
    if (isUniqueViolation(error, "backstage_messages_organization_id_idempotency_key_key")) {
      const again = await replay();
      if (again) return again;
    }
    if (isUniqueViolation(error, "backstage_messages_one_ack")) throw new DomainError("cue_already_acknowledged_conflict");
    throw error;
  }
}

async function performanceEntry(tx: Sql, organizationId: string, competitionId: string, performanceId: unknown): Promise<string> {
  if (!isUuid(performanceId)) throw new DomainError("performance_not_found");
  const [row] = await tx<{ entry_id: string }[]>`SELECT entry_id FROM performances
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${performanceId}`;
  if (!row) throw new DomainError("performance_not_found");
  return row.entry_id;
}

/** Performer reports readiness for a performance of an entry they are linked to. */
export async function postCheckin(
  organizationId: string, competitionId: string, author: BackstageAuthor,
  input: { performanceId: string; readiness: unknown; note?: unknown; idempotencyKey: string }
): Promise<BackstageMessage> {
  assertReadiness(input.readiness);
  const body = normalizeBody(input.note, BACKSTAGE_LIMITS.checkinNote, 0);
  return append(organizationId, competitionId, author, {
    kind: "checkin", performanceId: input.performanceId, readiness: input.readiness, body, idempotencyKey: input.idempotencyKey
  }, async tx => {
    const entryId = await performanceEntry(tx, organizationId, competitionId, input.performanceId);
    const linked = await listLinkedEntryIds(organizationId, competitionId, author.accountId, tx);
    if (!linked.includes(entryId)) throw new DomainError("forbidden");
    return { entryId };
  });
}

/** Producer cue to the performer(s) of one performance. */
export async function postCue(
  organizationId: string, competitionId: string, author: BackstageAuthor,
  input: { performanceId: string; body: unknown; idempotencyKey: string }
): Promise<BackstageMessage> {
  const body = normalizeBody(input.body, BACKSTAGE_LIMITS.cueBody);
  return append(organizationId, competitionId, author, {
    kind: "cue", performanceId: input.performanceId, body, idempotencyKey: input.idempotencyKey
  }, async tx => ({ entryId: await performanceEntry(tx, organizationId, competitionId, input.performanceId) }));
}

/** Performer acknowledges a cue addressed to one of their entries (once). */
export async function acknowledgeCue(
  organizationId: string, competitionId: string, author: BackstageAuthor,
  input: { cueId: string; idempotencyKey: string }
): Promise<BackstageMessage> {
  return append(organizationId, competitionId, author, {
    kind: "cue_ack", body: "", idempotencyKey: input.idempotencyKey
  }, async tx => {
    if (!isUuid(input.cueId)) throw new DomainError("cue_not_found");
    const [cue] = await tx<{ seq: string; entry_id: string; performance_id: string | null }[]>`
      SELECT seq::text, entry_id, performance_id FROM backstage_messages
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${input.cueId} AND kind = 'cue'`;
    const linked = await listLinkedEntryIds(organizationId, competitionId, author.accountId, tx);
    // A cue for someone else's entry is indistinguishable from a missing cue.
    if (!cue || !linked.includes(cue.entry_id)) throw new DomainError("cue_not_found");
    return { refSeq: Number(cue.seq), entryId: cue.entry_id, performanceId: cue.performance_id };
  });
}

/** Private producer <-> judge channel. */
export async function postJudgeMessage(
  organizationId: string, competitionId: string, author: BackstageAuthor,
  input: { body: unknown; idempotencyKey: string }
): Promise<BackstageMessage> {
  const body = normalizeBody(input.body, BACKSTAGE_LIMITS.judgeMessage);
  return append(organizationId, competitionId, author, { kind: "judge_message", body, idempotencyKey: input.idempotencyKey });
}

/**
 * Role-filtered feed after cursor `since`. `cursor` is the competition-wide head seq
 * observed in the same snapshot, so the next poll never re-reads or skips rows.
 */
export async function listBackstageMessages(
  organizationId: string, competitionId: string, viewer: BackstageAuthor, since: number
): Promise<{ messages: BackstageMessage[]; cursor: number; hasMore: boolean }> {
  const sql = getSqlClient();
  await assertCompetitionInTenant(sql, organizationId, competitionId);
  const linked = viewer.role === "performer" ? await listLinkedEntryIds(organizationId, competitionId, viewer.accountId) : [];
  const limit = BACKSTAGE_LIMITS.pageSize;
  const visibility =
    viewer.role === "producer" ? sql`TRUE`
      : viewer.role === "judge" ? sql`m.kind = 'judge_message'`
        : sql`((m.kind = 'cue' AND m.entry_id = ANY(${linked}::uuid[]))
              OR (m.kind IN ('checkin', 'cue_ack') AND m.author_account_id = ${viewer.accountId}))`;
  const rows = await sql<(MessageRow & { head: string })[]>`
    WITH head AS (SELECT COALESCE(max(seq), 0) AS head FROM backstage_messages
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId})
    SELECT m.id, m.seq::text, m.kind, m.performance_id, m.entry_id, m.readiness, m.body, m.ref_seq::text,
      m.author_account_id, m.author_role, m.created_at, head.head::text AS head
    FROM head LEFT JOIN backstage_messages m ON m.organization_id = ${organizationId}
      AND m.competition_id = ${competitionId} AND m.seq > ${since} AND ${visibility}
    ORDER BY m.seq NULLS FIRST LIMIT ${limit + 1}
  `;
  const head = Number(rows[0]?.head ?? 0);
  const found = rows.filter(row => row.id !== null);
  const hasMore = found.length > limit;
  const page = found.slice(0, limit);
  const linkedSet = new Set(linked);
  // Defense in depth: re-apply the pure visibility rule.
  const messages = page
    .filter(row => canViewMessage({ ...viewer, linkedEntryIds: linkedSet }, { kind: row.kind, authorAccountId: row.author_account_id, entryId: row.entry_id }))
    .map(row => toMessage(row, viewer));
  const cursor = hasMore ? Number(page[page.length - 1]!.seq) : Math.max(head, since);
  return { messages, cursor, hasMore };
}

/** Producer view: latest readiness per performance and performer account. */
export async function getReadiness(organizationId: string, competitionId: string) {
  const sql = getSqlClient();
  await assertCompetitionInTenant(sql, organizationId, competitionId);
  const rows = await sql<{ performance_id: string; author_account_id: string; readiness: Readiness; body: string; seq: string; created_at: Date }[]>`
    SELECT DISTINCT ON (performance_id, author_account_id) performance_id, author_account_id, readiness, body, seq::text, created_at
    FROM backstage_messages
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND kind = 'checkin'
    ORDER BY performance_id, author_account_id, seq DESC
  `;
  return rows.map(row => ({
    performanceId: row.performance_id,
    accountId: row.author_account_id,
    readiness: row.readiness,
    note: row.body,
    seq: Number(row.seq),
    updatedAt: row.created_at.toISOString()
  }));
}
