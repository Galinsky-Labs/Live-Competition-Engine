import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { verifyAuditChain } from "./audit.ts";
import { createAccount, createTenant } from "./test-fixtures.ts";
import {
  advanceSubscription,
  aggregateUsage,
  assertPlanLimit,
  cancelPendingDowngrade,
  changePlan,
  checkPlanLimit,
  createPlanVersion,
  getSubscription,
  planAllowsFeature,
  publishPlan,
  recordUsage,
  retirePlan,
  setSubscriptionStatus,
  startSubscription
} from "./saas-plans.ts";

after(closeDatabaseConnection);

const key = () => `t${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const idem = () => `idem-${randomUUID()}`;
const limits = (overrides: Record<string, number | null> = {}) => ({
  max_events_per_month: 10, max_storage_bytes: 1_000_000, max_members: 10, max_custom_domains: 2, ...overrides
});

async function publishedPlan(actor: string, overrides: Record<string, unknown> = {}) {
  const plan = await createPlanVersion(actor, {
    planKey: key(), name: "Plan", currency: "USD", billingInterval: "month", priceMinor: 3000,
    trialDays: 0, features: ["voting", "chat"], limits: limits(), ...overrides
  });
  return publishPlan(actor, plan.id);
}

test("plan versions are sequential, immutable once published, and audited on the platform chain", async () => {
  const actor = await createAccount();
  const planKey = key();
  const input = { planKey, name: "Pro", currency: "USD", billingInterval: "month", priceMinor: 1000, trialDays: 7, features: ["voting"], limits: limits() };
  const v1 = await createPlanVersion(actor, input);
  const v2 = await createPlanVersion(actor, { ...input, priceMinor: 1200 });
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v1.status, "draft");
  await assert.rejects(createPlanVersion(actor, { ...input, features: ["not_a_feature"] }), { code: "invalid_plan" });

  const published = await publishPlan(actor, v1.id);
  assert.equal(published.status, "published");
  await assert.rejects(publishPlan(actor, v1.id), { code: "invalid_state_plan_transition" });
  await assert.rejects(getSqlClient()`UPDATE saas_plans SET price_minor = 1 WHERE id = ${v1.id}`, /immutable/);
  await assert.rejects(getSqlClient()`DELETE FROM saas_plans WHERE id = ${v1.id}`, /cannot be deleted/);
  const retired = await retirePlan(actor, v1.id);
  assert.equal(retired.status, "retired");
  await assert.rejects(getSqlClient()`UPDATE saas_plans SET status = 'published' WHERE id = ${v1.id}`, /cannot be republished/);
  await getSqlClient()`DELETE FROM saas_plans WHERE id = ${v2.id}`; // drafts may be deleted
  assert.equal((await verifyAuditChain(null)).valid, true);
});

test("subscription lifecycle: trial, idempotency, upgrade proration, scheduled downgrade, renewals", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const trialPlan = await publishedPlan(actor, { priceMinor: 3000, trialDays: 14 });
  const bigPlan = await publishedPlan(actor, { priceMinor: 9000 });
  const smallPlan = await publishedPlan(actor, { priceMinor: 1000, features: [] });
  const t0 = new Date("2026-01-01T00:00:00Z");
  const startKey = idem();

  const started = await startSubscription(org, actor, { planId: trialPlan.id, idempotencyKey: startKey }, t0);
  assert.equal(started.subscription.status, "trialing");
  assert.equal(started.change.chargeMinor, 0);
  const replay = await startSubscription(org, actor, { planId: trialPlan.id, idempotencyKey: startKey }, t0);
  assert.equal(replay.replayed, true);
  assert.equal(replay.subscription.id, started.subscription.id);
  await assert.rejects(startSubscription(org, actor, { planId: trialPlan.id, idempotencyKey: idem() }, t0), { code: "subscription_conflict" });
  assert.equal(await planAllowsFeature(org, "voting"), true);
  assert.equal(await planAllowsFeature(org, "ppv"), false);

  // Trial ends on 2026-01-15: first paid period starts and the charge is exposed (collection is LC-51).
  const trialEnd = await advanceSubscription(org, new Date("2026-01-20T00:00:00Z"));
  assert.deepEqual(trialEnd.map(c => [c.kind, c.chargeMinor]), [["trial_ended", 3000]]);
  assert.equal((await advanceSubscription(org, new Date("2026-01-20T00:00:00Z"))).length, 0);

  // Upgrade mid-period: 16 of 31 days remain.
  const upgrade = await changePlan(org, actor, { planId: bigPlan.id, idempotencyKey: idem() }, new Date("2026-01-30T00:00:00Z"));
  assert.ok(upgrade.outcome === "applied");
  assert.deepEqual([upgrade.change.creditMinor, upgrade.change.chargeMinor, upgrade.change.netMinor], [1548, 4645, 3097]);
  assert.equal(upgrade.subscription.planId, bigPlan.id);

  // Downgrade is scheduled at period end, can be cancelled, and is idempotent.
  const downKey = idem();
  const down = await changePlan(org, actor, { planId: smallPlan.id, idempotencyKey: downKey }, new Date("2026-02-01T00:00:00Z"));
  assert.ok(down.outcome === "scheduled");
  assert.equal(down.subscription.planId, bigPlan.id);
  assert.equal(down.subscription.pendingChangeAt?.toISOString(), "2026-02-15T00:00:00.000Z");
  const downReplay = await changePlan(org, actor, { planId: smallPlan.id, idempotencyKey: downKey });
  assert.ok(downReplay.outcome === "scheduled" && downReplay.replayed);
  await cancelPendingDowngrade(org, actor);
  await assert.rejects(cancelPendingDowngrade(org, actor), { code: "invalid_state_no_pending_change" });
  await changePlan(org, actor, { planId: smallPlan.id, idempotencyKey: idem() }, new Date("2026-02-02T00:00:00Z"));

  const steps = await advanceSubscription(org, new Date("2026-03-20T00:00:00Z"));
  assert.deepEqual(steps.map(c => [c.kind, c.chargeMinor]), [["downgrade_applied", 1000], ["renewed", 1000]]);
  const view = await getSubscription(org);
  assert.equal(view?.subscription.planId, smallPlan.id);
  assert.equal(view?.subscription.currentPeriodEnd.toISOString(), "2026-04-15T00:00:00.000Z");
  assert.equal(view?.pendingPlan, null);
  assert.equal(await planAllowsFeature(org, "voting"), false);

  // Status machine.
  await assert.rejects(setSubscriptionStatus(org, actor, "trialing"), { code: "invalid_state_subscription_transition" });
  await setSubscriptionStatus(org, actor, "past_due");
  await assert.rejects(setSubscriptionStatus(org, actor, "active", { expectedRevision: 1 }), { code: "subscription_revision_conflict" });
  await setSubscriptionStatus(org, actor, "active");
  await setSubscriptionStatus(org, actor, "cancelled");
  await assert.rejects(setSubscriptionStatus(org, actor, "active"), { code: "subscription_not_found" });
  assert.equal((await checkPlanLimit(org, "max_members")).reason, "no_active_subscription");
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("plan changes are blocked or flagged when usage exceeds the new limits", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  await createAccount(org);
  await createAccount(org); // three active members
  const current = await publishedPlan(actor, { priceMinor: 5000 });
  const tiny = await publishedPlan(actor, { priceMinor: 100, limits: limits({ max_members: 2 }) });
  const tinyUpgrade = await publishedPlan(actor, { priceMinor: 9999, limits: limits({ max_members: 1 }) });
  await startSubscription(org, actor, { planId: current.id, idempotencyKey: idem() });

  assert.equal((await changePlan(org, actor, { planId: tinyUpgrade.id, idempotencyKey: idem() })).outcome, "blocked");
  const blocked = await changePlan(org, actor, { planId: tiny.id, idempotencyKey: idem() });
  assert.deepEqual(blocked, { outcome: "blocked", violations: [{ limitKey: "max_members", limit: 2, current: 3 }] });
  const flagged = await changePlan(org, actor, { planId: tiny.id, idempotencyKey: idem(), acknowledgeOverage: true });
  assert.ok(flagged.outcome === "scheduled");
  assert.equal(flagged.subscription.pendingOverageFlagged, true);

  const eur = await publishedPlan(actor, { currency: "EUR", priceMinor: 1 });
  await assert.rejects(changePlan(org, actor, { planId: eur.id, idempotencyKey: idem() }), { code: "plan_change_currency_mismatch" });
  await assert.rejects(changePlan(org, actor, { planId: current.id, idempotencyKey: idem() }), { code: "plan_change_noop" });
});

test("checkPlanLimit fails closed and serializes concurrent consumers", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  assert.equal((await checkPlanLimit(org, "max_events_per_month")).allowed, false);
  await assert.rejects(assertPlanLimit(org, "max_events_per_month"), { code: "no_active_subscription" });
  const plan = await publishedPlan(actor, { limits: limits({ max_events_per_month: 1, max_custom_domains: null }) });
  await startSubscription(org, actor, { planId: plan.id, idempotencyKey: idem() });
  assert.equal((await checkPlanLimit(org, "max_custom_domains", 1000)).remaining, null);
  await assert.rejects(checkPlanLimit(org, "bogus" as never), { code: "invalid_limit_key" });

  const attempt = () => getSqlClient().begin(async tx => {
    await assertPlanLimit(org, "max_events_per_month", 1, { sql: tx });
    await tx`INSERT INTO competitions (id, organization_id, title) VALUES (${randomUUID()}, ${org}, 'Limited')`;
  });
  const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason.code === "plan_limit_exceeded"));
});

test("usage records are append-only, idempotent and aggregated per tenant period", async () => {
  const orgA = await createTenant();
  const orgB = await createTenant();
  const actorA = await createAccount(orgA);
  const at = new Date("2026-05-10T12:00:00Z");
  const k = idem();
  const first = await recordUsage(orgA, { metric: "storage_bytes", quantity: 500, idempotencyKey: k, source: "media.upload", occurredAt: at });
  const again = await recordUsage(orgA, { metric: "storage_bytes", quantity: 500, idempotencyKey: k, source: "media.upload", occurredAt: at });
  assert.equal(first.recorded, true);
  assert.equal(again.recorded, false);
  assert.equal(again.id, first.id);
  await assert.rejects(recordUsage(orgA, { metric: "storage_bytes", quantity: 9, idempotencyKey: k, source: "media.upload" }), { code: "usage_idempotency_conflict" });
  await recordUsage(orgA, { metric: "storage_bytes", quantity: -200, idempotencyKey: idem(), source: "media.delete", occurredAt: at });
  await recordUsage(orgA, { metric: "api_calls", quantity: 3, idempotencyKey: idem(), source: "api", occurredAt: new Date("2026-06-01T00:00:00Z") });
  // The same idempotency key in another tenant is independent.
  await recordUsage(orgB, { metric: "storage_bytes", quantity: 7, idempotencyKey: k, source: "media.upload", occurredAt: at });
  await assert.rejects(recordUsage(orgA, { metric: "Bad", quantity: 1, idempotencyKey: idem(), source: "x1" }), { code: "invalid_usage_metric" });
  await assert.rejects(recordUsage(orgA, { metric: "api_calls", quantity: 0, idempotencyKey: idem(), source: "x1" }), { code: "invalid_usage_quantity" });

  assert.deepEqual(await aggregateUsage(orgA, at), { periodStart: "2026-05-01", metrics: { storage_bytes: { total: 300, records: 2 } } });
  assert.deepEqual((await aggregateUsage(orgB, at)).metrics, { storage_bytes: { total: 7, records: 1 } });
  await assert.rejects(getSqlClient()`UPDATE usage_records SET quantity = 1 WHERE id = ${first.id}`, /append-only/);

  // Cross-tenant: tenant B cannot change or observe tenant A's subscription.
  const plan = await publishedPlan(actorA);
  await startSubscription(orgA, actorA, { planId: plan.id, idempotencyKey: idem() });
  await assert.rejects(changePlan(orgB, actorA, { planId: plan.id, idempotencyKey: idem() }), { code: "subscription_not_found" });
  await assert.rejects(setSubscriptionStatus(orgB, actorA, "cancelled"), { code: "subscription_not_found" });
  assert.equal(await getSubscription(orgB), null);
  const limitB = await checkPlanLimit(orgB, "max_storage_bytes");
  assert.equal(limitB.reason, "no_active_subscription");
  assert.equal(limitB.current, 7);
});
