import { DomainError } from "@live-competition-engine/domain";
import { windowStart } from "@live-competition-engine/domain/moderation";
import type { Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * Fixed-window counter in PostgreSQL (`bucket_rate_limits`). Atomic via upsert, so
 * concurrent callers can never exceed `limit` successes per window. Throws
 * DomainError("rate_limited") when the window is exhausted. Pass a transaction
 * handle to make the consumption roll back with the guarded write.
 */
export async function consumeRateLimit(
  bucketKey: string,
  limit: number,
  windowMs: number,
  options: { sql?: Sql; now?: Date } = {}
): Promise<{ remaining: number; resetAt: Date }> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new DomainError("invalid_rate_limit");
  const sql = options.sql ?? getSqlClient();
  const start = windowStart(options.now ?? new Date(), windowMs);
  const [row] = await sql<{ count: number }[]>`
    INSERT INTO bucket_rate_limits (bucket_key, window_start, count) VALUES (${bucketKey}, ${start}, 1)
    ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = bucket_rate_limits.count + 1
    WHERE bucket_rate_limits.count < ${limit}
    RETURNING count
  `;
  if (!row) throw new DomainError("rate_limited");
  return { remaining: limit - row.count, resetAt: new Date(start.getTime() + windowMs) };
}

/** Housekeeping: drop windows that ended before `before`. */
export async function pruneRateLimits(before: Date): Promise<number> {
  const rows = await getSqlClient()`DELETE FROM bucket_rate_limits WHERE window_start < ${before} RETURNING 1`;
  return rows.length;
}
