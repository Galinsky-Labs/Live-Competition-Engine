import { createHash } from "node:crypto";
import type postgres from "postgres";
import { getSqlClient } from "./index.ts";

/** Any postgres-js executor: the pooled client or a transaction handle. */
export type Sql = postgres.Sql | postgres.TransactionSql;

export interface AuditInput {
  organizationId: string | null;
  actorAccountId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
}

export interface AuditRecord extends Required<AuditInput> {
  sequence: number;
  recordedAt: Date;
  previousHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/** Deterministic JSON with sorted keys so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function auditHash(previousHash: string, record: Omit<AuditRecord, "hash" | "previousHash">): string {
  return createHash("sha256").update(canonicalJson({
    previousHash,
    organizationId: record.organizationId,
    sequence: record.sequence,
    actorAccountId: record.actorAccountId,
    action: record.action,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    details: record.details,
    recordedAt: record.recordedAt.toISOString()
  })).digest("hex");
}

/**
 * Append an audit event inside the caller's transaction. A per-chain advisory
 * lock serializes writers so sequence and hash links are gap-free. Call it in the
 * same transaction as the state change it evidences: if either fails, both roll back.
 */
export async function recordAudit(tx: Sql, input: AuditInput): Promise<AuditRecord> {
  const chainKey = input.organizationId ?? "platform";
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"audit:" + chainKey}, 0))`;
  const [last] = await tx<{ sequence: string; hash: string }[]>`
    SELECT sequence::text, hash FROM audit_events
    WHERE chain_key = ${chainKey} ORDER BY audit_events.sequence DESC LIMIT 1
  `;
  const sequence = last ? Number(last.sequence) + 1 : 1;
  const previousHash = last?.hash ?? GENESIS;
  // Millisecond precision so the stored timestamp round-trips exactly.
  const recordedAt = new Date(Math.floor(Date.now()));
  const base = {
    organizationId: input.organizationId,
    actorAccountId: input.actorAccountId,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    details: JSON.parse(canonicalJson(input.details ?? {})) as Record<string, unknown>,
    sequence,
    recordedAt
  };
  const hash = auditHash(previousHash, base);
  await tx`
    INSERT INTO audit_events (organization_id, chain_key, sequence, actor_account_id, action,
      subject_type, subject_id, details, recorded_at, previous_hash, hash)
    VALUES (${input.organizationId}, ${chainKey}, ${sequence}, ${input.actorAccountId}, ${input.action},
      ${input.subjectType}, ${input.subjectId}, ${tx.json(base.details as postgres.JSONValue)}, ${recordedAt},
      ${previousHash}, ${hash})
  `;
  return { ...base, previousHash, hash };
}

/** Convenience wrapper that opens its own transaction. */
export async function recordAuditNow(input: AuditInput): Promise<AuditRecord> {
  return getSqlClient().begin(tx => recordAudit(tx, input));
}

export interface AuditVerification {
  valid: boolean;
  count: number;
  headHash: string;
  firstInvalidSequence: number | null;
}

/** Recompute every hash link in one chain; detects edits, gaps and reordering. */
export async function verifyAuditChain(organizationId: string | null, sql: Sql = getSqlClient()): Promise<AuditVerification> {
  const chainKey = organizationId ?? "platform";
  const rows = await sql<{
    organization_id: string | null; sequence: string; actor_account_id: string | null; action: string;
    subject_type: string; subject_id: string; details: Record<string, unknown>; recorded_at: Date;
    previous_hash: string; hash: string;
  }[]>`
    SELECT organization_id, sequence::text, actor_account_id, action, subject_type, subject_id,
      details, recorded_at, previous_hash, hash
    FROM audit_events WHERE chain_key = ${chainKey} ORDER BY audit_events.sequence
  `;
  let previous = GENESIS;
  for (const [index, row] of rows.entries()) {
    const sequence = Number(row.sequence);
    const expected = auditHash(previous, {
      organizationId: row.organization_id,
      actorAccountId: row.actor_account_id,
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      details: row.details,
      sequence,
      recordedAt: row.recorded_at
    });
    if (sequence !== index + 1 || row.previous_hash !== previous || row.hash !== expected) {
      return { valid: false, count: rows.length, headHash: previous, firstInvalidSequence: sequence };
    }
    previous = row.hash;
  }
  return { valid: true, count: rows.length, headHash: previous, firstInvalidSequence: null };
}

export async function listAuditEvents(
  organizationId: string | null,
  options: { limit?: number; beforeSequence?: number; subjectType?: string; subjectId?: string } = {},
  sql: Sql = getSqlClient()
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const chainKey = organizationId ?? "platform";
  return sql<{
    sequence: string; actor_account_id: string | null; action: string; subject_type: string;
    subject_id: string; details: Record<string, unknown>; recorded_at: Date; hash: string;
  }[]>`
    SELECT sequence::text, actor_account_id, action, subject_type, subject_id, details, recorded_at, hash
    FROM audit_events
    WHERE chain_key = ${chainKey}
      ${options.beforeSequence ? sql`AND sequence < ${options.beforeSequence}` : sql``}
      ${options.subjectType ? sql`AND subject_type = ${options.subjectType}` : sql``}
      ${options.subjectId ? sql`AND subject_id = ${options.subjectId}` : sql``}
    ORDER BY audit_events.sequence DESC LIMIT ${limit}
  `;
}
