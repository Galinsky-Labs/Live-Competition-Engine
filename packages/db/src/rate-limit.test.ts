import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DomainError } from "@live-competition-engine/domain";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { consumeRateLimit, pruneRateLimitCounters, slidingCarryOver } from "./rate-limit.ts";
import { createTenant } from "./test-fixtures.ts";
import { cleanupTenants } from "./audience-fixtures.ts";

const tenants: string[] = [];
after(async () => {
  await cleanupTenants(tenants);
  await closeDatabaseConnection();
});

const isRateLimited = (error: unknown) => error instanceof DomainError && error.code === "rate_limited";

test("sliding carry-over is a pure weighted count", () => {
  assert.equal(slidingCarryOver(10, 0, 1000, 0), 10);
  assert.equal(slidingCarryOver(10, 0, 1000, 500), 5);
  assert.equal(slidingCarryOver(10, 0, 1000, 1000), 0);
  assert.equal(slidingCarryOver(10, 0, 1000, 250), 7);
});

test("fixed window allows exactly the limit, resets at the boundary and is scoped per key", async () => {
  const org = await createTenant();
  const other = await createTenant();
  tenants.push(org, other);
  const sql = getSqlClient();
  const account = randomUUID();
  const rule = { limit: 3, windowMs: 60_000 };
  const t0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  for (let i = 0; i < 3; i++) {
    const result = await consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.fixed" }, rule, t0);
    assert.equal(result.remaining, 2 - i);
  }
  await assert.rejects(consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.fixed" }, rule, t0), isRateLimited);
  // Different action, different tenant, different account: independent buckets.
  await consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.other" }, rule, t0);
  await consumeRateLimit(sql, { organizationId: other, accountId: account, action: "test.fixed" }, rule, t0);
  await consumeRateLimit(sql, { organizationId: org, accountId: randomUUID(), action: "test.fixed" }, rule, t0);
  // Next window.
  await consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.fixed" }, rule, new Date(t0.getTime() + 60_000));
  await assert.rejects(consumeRateLimit(sql, { organizationId: "nope", accountId: account, action: "x" }, rule, t0), /invalid_rate_limit_key/);
  await assert.rejects(consumeRateLimit(sql, { organizationId: org, accountId: account, action: "x" }, { limit: 0, windowMs: 1000 }, t0), /invalid_rate_limit_rule/);
});

test("concurrent hits never exceed the limit", async () => {
  const org = await createTenant();
  tenants.push(org);
  const sql = getSqlClient();
  const account = randomUUID();
  const now = new Date();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
    consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.race" }, { limit: 5, windowMs: 3_600_000 }, now)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 5);
  assert.ok(results.filter(result => result.status === "rejected").every(result => isRateLimited((result as PromiseRejectedResult).reason)));
});

test("sliding window carries the previous window's weight", async () => {
  const org = await createTenant();
  tenants.push(org);
  const sql = getSqlClient();
  const account = randomUUID();
  const rule = { limit: 4, windowMs: 10_000, mode: "sliding" as const };
  const start = new Date(Math.floor(Date.now() / 10_000) * 10_000 - 100_000);
  for (let i = 0; i < 4; i++) await consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.slide" }, rule, start);
  // 2.5 s into the next window 75% of the previous 4 still count => 3 carried, 1 allowed.
  const mid = new Date(start.getTime() + 12_500);
  await consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.slide" }, rule, mid);
  await assert.rejects(consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.slide" }, rule, mid), isRateLimited);
  // A rejected hit inside a rolled-back transaction leaves no trace.
  await assert.rejects(sql.begin(async tx => {
    await consumeRateLimit(tx, { organizationId: org, accountId: account, action: "test.tx" }, { limit: 1, windowMs: 60_000 }, mid);
    throw new Error("rollback");
  }), /rollback/);
  await consumeRateLimit(sql, { organizationId: org, accountId: account, action: "test.tx" }, { limit: 1, windowMs: 60_000 }, mid);
  assert.ok(await pruneRateLimitCounters(new Date(start.getTime() + 1)) >= 1);
});
