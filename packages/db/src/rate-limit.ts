import { DomainError, isUuid } from "@live-competition-engine/domain";
import type { Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * Reusable PostgreSQL-backed rate limiter keyed by tenant + account + action.
 *
 * * `fixed`: at most `limit` hits per aligned window of `windowMs`.
 * * `sliding`: sliding-window approximation; the previous window's count is
 *   weighted by the fraction of it still inside the sliding window.
 *
 * The increment is a single conditional upsert, so concurrent callers can never
 * exceed the limit. A rejected hit is not counted. When called with a
 * transaction handle the hit rolls back together with the caller's work.
 */
export interface RateLimitRule {
  limit: number;
  windowMs: number;
  mode?: "fixed" | "sliding";
}

export interface RateLimitKey {
  organizationId: string;
  accountId: string;
  action: string;
}

export interface RateLimitResult {
  count: number;
  remaining: number;
  resetAt: Date;
}

const ACTION_PATTERN = /^[a-z][a-z0-9_.:-]{0,99}$/;

export function validateRateLimit(key: RateLimitKey, rule: RateLimitRule): void {
  if (!isUuid(key.organizationId) || !isUuid(key.accountId) || !ACTION_PATTERN.test(key.action)) {
    throw new DomainError("invalid_rate_limit_key");
  }
  if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.limit > 1_000_000 ||
    !Number.isInteger(rule.windowMs) || rule.windowMs < 1000 || rule.windowMs > 86_400_000) {
    throw new DomainError("invalid_rate_limit_rule");
  }
}

/** Pure: how many hits from the previous window still count under the sliding approximation. */
export function slidingCarryOver(previousCount: number, windowStartMs: number, windowMs: number, nowMs: number): number {
  const elapsed = Math.min(Math.max(nowMs - windowStartMs, 0), windowMs);
  return Math.floor(previousCount * (1 - elapsed / windowMs));
}

/** Consume one hit or throw DomainError("rate_limited"). */
export async function consumeRateLimit(
  sql: Sql,
  key: RateLimitKey,
  rule: RateLimitRule,
  now: Date = new Date()
): Promise<RateLimitResult> {
  validateRateLimit(key, rule);
  const nowMs = now.getTime();
  const windowStartMs = Math.floor(nowMs / rule.windowMs) * rule.windowMs;
  const windowStart = new Date(windowStartMs);
  const resetAt = new Date(windowStartMs + rule.windowMs);
  let carry = 0;
  if (rule.mode === "sliding") {
    const [previous] = await sql<{ count: number }[]>`
      SELECT count FROM rate_limit_counters
      WHERE organization_id = ${key.organizationId} AND account_id = ${key.accountId}
        AND action = ${key.action} AND window_ms = ${rule.windowMs}
        AND window_start = ${new Date(windowStartMs - rule.windowMs)}
    `;
    carry = slidingCarryOver(previous?.count ?? 0, windowStartMs, rule.windowMs, nowMs);
  }
  const allowance = rule.limit - carry;
  if (allowance <= 0) throw new DomainError("rate_limited");
  const rows = await sql<{ count: number }[]>`
    INSERT INTO rate_limit_counters (organization_id, account_id, action, window_ms, window_start, count)
    VALUES (${key.organizationId}, ${key.accountId}, ${key.action}, ${rule.windowMs}, ${windowStart}, 1)
    ON CONFLICT (organization_id, account_id, action, window_ms, window_start)
    DO UPDATE SET count = rate_limit_counters.count + 1
    WHERE rate_limit_counters.count < ${allowance}
    RETURNING count
  `;
  const count = rows[0]?.count;
  if (count === undefined) throw new DomainError("rate_limited");
  return { count, remaining: Math.max(0, allowance - count), resetAt };
}

/** Delete counters whose window started before `before`. Returns rows removed. */
export async function pruneRateLimitCounters(before: Date, sql: Sql = getSqlClient()): Promise<number> {
  const result = await sql`DELETE FROM rate_limit_counters WHERE window_start < ${before}`;
  return result.count;
}
