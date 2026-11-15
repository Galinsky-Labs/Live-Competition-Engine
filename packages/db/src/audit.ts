import type { Sql, TransactionSql } from "postgres";

export interface AuditEntry {
  organizationId: string | null;
  actorAccountId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
}

type Executor = Sql | TransactionSql;

/** Appends an immutable audit row. Call inside the same transaction as the change it records. */
export async function recordAudit(tx: Executor, entry: AuditEntry): Promise<void> {
  await tx`
    INSERT INTO engine_audit_log (organization_id, actor_account_id, action, subject_type, subject_id, details)
    VALUES (${entry.organizationId}, ${entry.actorAccountId}, ${entry.action}, ${entry.subjectType}, ${entry.subjectId},
      ${tx.json((entry.details ?? {}) as never)})
  `;
}

export interface AuditRow {
  id: number;
  action: string;
  subjectType: string;
  subjectId: string;
  actorAccountId: string | null;
  details: Record<string, unknown>;
  recordedAt: Date;
}

export async function listAudit(tx: Executor, organizationId: string, subjectType?: string, subjectId?: string, limit = 100): Promise<AuditRow[]> {
  const rows = await tx<{ id: string; action: string; subject_type: string; subject_id: string; actor_account_id: string | null; details: Record<string, unknown>; recorded_at: Date }[]>`
    SELECT id, action, subject_type, subject_id, actor_account_id, details, recorded_at
    FROM engine_audit_log
    WHERE organization_id = ${organizationId}
      ${subjectType ? tx`AND subject_type = ${subjectType}` : tx``}
      ${subjectId ? tx`AND subject_id = ${subjectId}` : tx``}
    ORDER BY id DESC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
  return rows.map(r => ({ id: Number(r.id), action: r.action, subjectType: r.subject_type, subjectId: r.subject_id, actorAccountId: r.actor_account_id, details: r.details, recordedAt: r.recorded_at }));
}
