import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection } from "./index.ts";
import { createTenant } from "./test-fixtures.ts";
import { claimJobs, completeJob, enqueueJob, failJob, getJob, PermanentJobError, runJobs } from "./jobs.ts";

after(closeDatabaseConnection);

const uniqueKind = () => `test.k${randomUUID().replace(/-/g, "").slice(0, 12)}`;

test("enqueue is idempotent per tenant, kind and key", async () => {
  const org = await createTenant();
  const kind = uniqueKind();
  const first = await enqueueJob({ organizationId: org, kind, idempotencyKey: "k1" });
  const second = await enqueueJob({ organizationId: org, kind, idempotencyKey: "k1" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  const otherTenant = await enqueueJob({ organizationId: await createTenant(), kind, idempotencyKey: "k1" });
  assert.notEqual(otherTenant.id, first.id);
});

test("concurrent workers never claim the same job (SKIP LOCKED)", async () => {
  const kind = uniqueKind();
  const ids = await Promise.all(Array.from({ length: 10 }, () => enqueueJob({ organizationId: null, kind })));
  const batches = await Promise.all(Array.from({ length: 4 }, () => claimJobs({ kinds: [kind], limit: 5 })));
  const claimed = batches.flat().map(job => job.id);
  assert.equal(claimed.length, 10);
  assert.equal(new Set(claimed).size, 10);
  assert.deepEqual(new Set(claimed), new Set(ids.map(job => job.id)));
});

test("failures back off exponentially, then die after max attempts; stale leases cannot complete", async () => {
  const kind = uniqueKind();
  const { id } = await enqueueJob({ organizationId: null, kind, maxAttempts: 2, backoffBaseMs: 1000 });
  const t0 = new Date();
  const [first] = await claimJobs({ kinds: [kind], now: t0 });
  assert.equal(first?.attempts, 1);
  assert.equal(await failJob(first!, new Error("boom"), { now: t0, random: () => 1 }), "queued");
  assert.equal((await getJob(id))?.run_at.getTime(), t0.getTime() + 1000);
  assert.deepEqual(await claimJobs({ kinds: [kind], now: new Date(t0.getTime() + 500) }), []);
  const [second] = await claimJobs({ kinds: [kind], now: new Date(t0.getTime() + 1000) });
  assert.equal(second?.attempts, 2);
  assert.equal(await completeJob({ id, leaseToken: first!.leaseToken }), false, "old lease token is fenced");
  assert.equal(await failJob(second!, new Error("again")), "dead");
  assert.equal((await getJob(id))?.status, "dead");
});

test("expired leases are reclaimed by another worker", async () => {
  const kind = uniqueKind();
  const { id } = await enqueueJob({ organizationId: null, kind });
  const t0 = new Date();
  const [crashed] = await claimJobs({ kinds: [kind], now: t0, leaseMs: 1000 });
  const [recovered] = await claimJobs({ kinds: [kind], now: new Date(t0.getTime() + 2000) });
  assert.equal(recovered?.id, id);
  assert.notEqual(recovered?.leaseToken, crashed?.leaseToken);
  assert.equal(await completeJob(crashed!), false);
  assert.equal(await completeJob(recovered!), true);
});

test("runJobs dispatches by kind and treats permanent errors as dead", async () => {
  const ok = uniqueKind();
  const bad = uniqueKind();
  await enqueueJob({ organizationId: null, kind: ok, payload: { n: 1 } });
  const { id: badId } = await enqueueJob({ organizationId: null, kind: bad });
  const seen: unknown[] = [];
  const summary = await runJobs({
    [ok]: async job => { seen.push(job.payload.n); },
    [bad]: async () => { throw new PermanentJobError("nope"); }
  });
  assert.deepEqual(seen, [1]);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.dead, 1);
  assert.equal((await getJob(badId))?.status, "dead");
});
