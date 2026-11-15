import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { DomainError } from "@live-competition-engine/domain";
import { outcomeAfterFailure, summarizeError } from "@live-competition-engine/domain/jobs";
import type { Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-47 generic durable job queue on PostgreSQL. Workers claim with
 * `FOR UPDATE SKIP LOCKED` and hold a lease token; only the lease holder may
 * complete or fail a job. Expired leases are reclaimed (crashed workers).
 */

export interface EnqueueInput {
  organizationId: string | null;
  kind: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
  backoffBaseMs?: number;
  idempotencyKey?: string;
}

export interface Job {
  id: string;
  organizationId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  backoffBaseMs: number;
  leaseToken: string;
  leaseExpiresAt: Date;
}

/** Thrown by a handler to stop retrying (the job goes straight to dead). */
export class PermanentJobError extends Error {
  readonly permanent = true;
}

/** Enqueue (optionally inside the caller's transaction). Idempotent per (tenant, kind, key). */
export async function enqueueJob(input: EnqueueInput, sql: Sql = getSqlClient()): Promise<{ id: string; created: boolean }> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(input.kind)) throw new DomainError("invalid_job_kind");
  const rows = await sql<{ id: string }[]>`
    INSERT INTO jobs (organization_id, kind, payload, run_at, max_attempts, backoff_base_ms, idempotency_key)
    VALUES (${input.organizationId}, ${input.kind}, ${sql.json((input.payload ?? {}) as postgres.JSONValue)},
      ${input.runAt ?? new Date()}, ${input.maxAttempts ?? 5}, ${input.backoffBaseMs ?? 30_000}, ${input.idempotencyKey ?? null})
    ON CONFLICT (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, idempotency_key)
      WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id
  `;
  if (rows[0]) return { id: rows[0].id, created: true };
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM jobs WHERE COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = COALESCE(${input.organizationId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      AND kind = ${input.kind} AND idempotency_key = ${input.idempotencyKey ?? null}
  `;
  if (!existing) throw new DomainError("job_conflict");
  return { id: existing.id, created: false };
}

type JobRow = {
  id: string; organization_id: string | null; kind: string; payload: Record<string, unknown>; attempts: number;
  max_attempts: number; backoff_base_ms: number; lease_token: string; lease_expires_at: Date;
};

/** Claim up to `limit` runnable jobs: queued and due, or running with an expired lease. */
export async function claimJobs(options: { limit?: number; leaseMs?: number; now?: Date; kinds?: string[]; organizationIds?: string[] } = {}): Promise<Job[]> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const leaseMs = Math.min(Math.max(options.leaseMs ?? 60_000, 1_000), 15 * 60_000);
  const now = options.now ?? new Date();
  const token = randomUUID();
  const sql = getSqlClient();
  return sql.begin(async tx => {
    // Expired leases that already used every attempt die instead of running again.
    await tx`
      UPDATE jobs SET status = 'dead', lease_token = NULL, lease_expires_at = NULL, updated_at = ${now}, completed_at = ${now},
        last_error = COALESCE(last_error, 'lease expired')
      WHERE id IN (
        SELECT id FROM jobs WHERE status = 'running' AND lease_expires_at <= ${now} AND attempts >= max_attempts
        FOR UPDATE SKIP LOCKED
      )
    `;
    const rows = await tx<JobRow[]>`
      UPDATE jobs SET status = 'running', lease_token = ${token}, lease_expires_at = ${new Date(now.getTime() + leaseMs)},
        attempts = attempts + 1, updated_at = ${now}
      WHERE id IN (
        SELECT id FROM jobs
        WHERE ((status = 'queued' AND run_at <= ${now}) OR (status = 'running' AND lease_expires_at <= ${now}))
          ${options.kinds?.length ? tx`AND kind IN ${tx(options.kinds)}` : tx``}
          ${options.organizationIds?.length ? tx`AND organization_id IN ${tx(options.organizationIds)}` : tx``}
        ORDER BY run_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, organization_id, kind, payload, attempts, max_attempts, backoff_base_ms, lease_token, lease_expires_at
    `;
    return rows.map(row => ({
      id: row.id, organizationId: row.organization_id, kind: row.kind, payload: row.payload, attempts: row.attempts,
      maxAttempts: row.max_attempts, backoffBaseMs: row.backoff_base_ms, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at
    }));
  });
}

export async function completeJob(job: Pick<Job, "id" | "leaseToken">, now = new Date()): Promise<boolean> {
  const rows = await getSqlClient()`
    UPDATE jobs SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL, completed_at = ${now}, updated_at = ${now}, last_error = NULL
    WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken} RETURNING id
  `;
  return rows.length === 1;
}

export async function failJob(
  job: Pick<Job, "id" | "leaseToken" | "attempts" | "maxAttempts" | "backoffBaseMs">,
  error: unknown,
  options: { now?: Date; random?: () => number } = {}
): Promise<"queued" | "dead" | "lost_lease"> {
  const now = options.now ?? new Date();
  const permanent = (error as { permanent?: unknown })?.permanent === true;
  const outcome = outcomeAfterFailure(job.attempts, job.maxAttempts, job.backoffBaseMs, permanent, options.random);
  const message = summarizeError(error);
  const rows = outcome.status === "dead"
    ? await getSqlClient()`
        UPDATE jobs SET status = 'dead', lease_token = NULL, lease_expires_at = NULL, last_error = ${message}, completed_at = ${now}, updated_at = ${now}
        WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken} RETURNING id`
    : await getSqlClient()`
        UPDATE jobs SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, last_error = ${message},
          run_at = ${new Date(now.getTime() + outcome.delayMs)}, updated_at = ${now}
        WHERE id = ${job.id} AND status = 'running' AND lease_token = ${job.leaseToken} RETURNING id`;
  return rows.length === 1 ? outcome.status : "lost_lease";
}

export type JobHandler = (job: Job) => Promise<void>;

export interface RunSummary { claimed: number; succeeded: number; retried: number; dead: number; lostLease: number }

/**
 * Claim and run one batch. A worker claims only the kinds it has handlers for, so
 * jobs of other kinds wait for a worker that understands them.
 */
export async function runJobs(
  handlers: Record<string, JobHandler>,
  options: { limit?: number; leaseMs?: number; now?: () => Date; organizationIds?: string[] } = {}
): Promise<RunSummary> {
  const clock = options.now ?? (() => new Date());
  const kinds = Object.keys(handlers);
  if (kinds.length === 0) return { claimed: 0, succeeded: 0, retried: 0, dead: 0, lostLease: 0 };
  const jobs = await claimJobs({ limit: options.limit, leaseMs: options.leaseMs, now: clock(), kinds, organizationIds: options.organizationIds });
  const summary: RunSummary = { claimed: jobs.length, succeeded: 0, retried: 0, dead: 0, lostLease: 0 };
  for (const job of jobs) {
    const handler = handlers[job.kind];
    try {
      if (!handler) throw new PermanentJobError(`no handler for ${job.kind}`);
      await handler(job);
      if (await completeJob(job, clock())) summary.succeeded += 1; else summary.lostLease += 1;
    } catch (error) {
      const outcome = await failJob(job, error, { now: clock() });
      if (outcome === "queued") summary.retried += 1;
      else if (outcome === "dead") summary.dead += 1;
      else summary.lostLease += 1;
    }
  }
  return summary;
}

export async function getJob(id: string) {
  const [row] = await getSqlClient()<{ status: string; attempts: number; run_at: Date; last_error: string | null; organization_id: string | null }[]>`
    SELECT status, attempts, run_at, last_error, organization_id FROM jobs WHERE id = ${id}
  `;
  return row ?? null;
}
