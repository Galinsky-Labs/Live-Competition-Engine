import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createTenant, enableFeature } from "./test-fixtures.ts";
import { setFeatureFlag } from "./feature-flags.ts";
import { FakePaymentProvider } from "./providers/fake-payments.ts";
import type { PaymentEvent } from "./providers/payments.ts";
import { ingestPaymentEvent, ledgerBalances, ledgerTrialBalance, requestRefund } from "./payments.ts";
import { fulfillmentHooks } from "./payment-fulfillment.ts";
import { grantsForSource } from "./entitlement-grants.ts";
import { verifyAuditChain } from "./audit.ts";
import {
  cancelSubscription,
  createMembershipPlan,
  expireLapsedSubscriptions,
  getSubscription,
  hasActiveSubscription,
  listMembershipPlans,
  subscribe
} from "./subscriptions.ts";

after(async () => { await closeDatabaseConnection(); });

const hooks = fulfillmentHooks();
const urls = () => ({ successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" });
const key = () => `test-${randomUUID()}`;
const deliver = (event: PaymentEvent) => ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: event.kind, rawBody: "{}", event }, hooks);
const day = 86_400_000;

async function setup() {
  const org = await createTenant("Subscriptions tenant");
  const operator = await createAccount(org);
  const creator = await createAccount(org);
  const fan = await createAccount(org);
  await enableFeature("subscriptions", org, operator);
  await enableFeature("creator_memberships", org, operator);
  const plan = await createMembershipPlan(org, {
    creatorType: "account", creatorId: creator, name: "Supporters", description: "", priceMinor: 500, currency: "USD", interval: "month", termsVersion: "2026-11"
  }, creator);
  return { org, operator, creator, fan, plan };
}

const consent = { accepted: true, termsVersion: "2026-11", priceMinor: 500, currency: "USD", interval: "month" };

test("subscribing requires explicit consent to the exact terms and records it", async () => {
  const { org, fan, plan, creator } = await setup();
  const provider = new FakePaymentProvider();
  await assert.rejects(subscribe(org, { planId: plan.id, accountId: fan, consent: { accepted: false }, idempotencyKey: key() }, provider, urls), /consent_required/);
  await assert.rejects(subscribe(org, { planId: plan.id, accountId: fan, consent: { ...consent, termsVersion: "old" }, idempotencyKey: key() }, provider, urls), /consent_terms_conflict/);
  await assert.rejects(subscribe(org, { planId: plan.id, accountId: fan, consent: { ...consent, priceMinor: 400 }, idempotencyKey: key() }, provider, urls), /consent_price_conflict/);
  await assert.rejects(subscribe(org, { planId: plan.id, accountId: creator, consent, idempotencyKey: key() }, provider, urls), /forbidden/);
  assert.equal(provider.calls, 0);
  const { subscription, redirectUrl } = await subscribe(org, { planId: plan.id, accountId: fan, consent, idempotencyKey: key() }, provider, urls);
  assert.equal(subscription.status, "incomplete");
  assert.ok(redirectUrl);
  assert.equal(subscription.consentTermsVersion, "2026-11");
  const audit = await getSqlClient()<{ details: { termsVersion: string } }[]>`
    SELECT details FROM audit_events WHERE organization_id = ${org} AND action = 'subscription.consent_recorded'`;
  assert.equal(audit[0]?.details.termsVersion, "2026-11");
  await assert.rejects(subscribe(org, { planId: plan.id, accountId: fan, consent, idempotencyKey: key() }, provider, urls), /subscription_conflict_exists/);
});

test("lifecycle: activation, renewal, past_due, replay, period-bounded access, cancellation at period end", async () => {
  const { org, fan, plan, creator, operator } = await setup();
  const provider = new FakePaymentProvider();
  const { subscription } = await subscribe(org, { planId: plan.id, accountId: fan, consent, idempotencyKey: key() }, provider, urls);
  const providerSubscriptionId = `sub_${randomUUID()}`;
  const meta = { organizationId: org, subscriptionId: subscription.id };
  // First invoice may arrive before checkout completion; metadata links it.
  const start = new Date(Date.now() - day);
  const end = new Date(Date.now() + 29 * day);
  const invoiceId = `in_${randomUUID()}`;
  const paid: PaymentEvent = { kind: "invoice_paid", providerSubscriptionId, ...meta, invoiceId, paymentReference: `pi_${randomUUID()}`, amountMinor: 500, currency: "USD", periodStart: start, periodEnd: end };
  assert.equal((await deliver(paid)).outcome, "subscription_renewed");
  assert.equal((await deliver({ kind: "subscription_checkout_completed", ...meta, providerSubscriptionId })).outcome, "subscription_linked");
  assert.equal((await deliver({ ...paid })).outcome, "duplicate_invoice");
  let sub = await getSubscription(org, subscription.id);
  assert.equal(sub?.status, "active");
  assert.equal(sub?.currentPeriodEnd?.getTime(), end.getTime());
  assert.equal(await hasActiveSubscription(org, fan, plan.id), true);
  assert.equal(await hasActiveSubscription(org, fan, plan.id, end.getTime() + 1), false, "access is bounded to the paid period");
  const grants = await grantsForSource(org, "subscription", subscription.id);
  assert.deepEqual(grants.map(g => [g.capability, Number(g.expires_at)]), [["content.view", end.getTime()]]);
  const balances = Object.fromEntries((await ledgerBalances(org)).map(b => [b.code, b.balanceMinor]));
  assert.equal(balances[`payable:account:${creator}`], -500);
  assert.deepEqual(await ledgerTrialBalance(org), { USD: 0 });

  assert.equal((await deliver({ kind: "invoice_payment_failed", providerSubscriptionId, organizationId: null, subscriptionId: null, invoiceId: `in_${randomUUID()}` })).outcome, "subscription_past_due");
  const nextEnd = new Date(end.getTime() + 30 * day);
  assert.equal((await deliver({ ...paid, organizationId: null, subscriptionId: null, invoiceId: `in_${randomUUID()}`, paymentReference: `pi_${randomUUID()}`, periodStart: end, periodEnd: nextEnd })).outcome, "subscription_renewed");
  sub = await getSubscription(org, subscription.id);
  assert.equal(sub?.status, "active");
  assert.equal(sub?.currentPeriodEnd?.getTime(), nextEnd.getTime());
  assert.equal(await hasActiveSubscription(org, fan, plan.id, end.getTime() + day), true);

  const cancelled = await cancelSubscription(org, subscription.id, { atPeriodEnd: true, actorAccountId: fan }, provider);
  assert.equal(cancelled.cancelAtPeriodEnd, true);
  assert.equal(cancelled.status, "active");
  assert.deepEqual(provider.cancellations, [{ providerSubscriptionId, atPeriodEnd: true }]);
  assert.equal(await hasActiveSubscription(org, fan, plan.id), true, "access continues until period end");
  assert.equal((await deliver({ kind: "subscription_ended", providerSubscriptionId, organizationId: org, subscriptionId: subscription.id })).outcome, "subscription_ended");
  assert.equal((await getSubscription(org, subscription.id))?.status, "cancelled");
  assert.equal(await hasActiveSubscription(org, fan, plan.id), false);
  // More than ten audit events: the hash chain must still verify (numeric, not text, ordering).
  const chain = await verifyAuditChain(org);
  assert.ok(chain.count > 10);
  assert.equal(chain.valid, true);
  assert.ok(operator);
});

test("immediate cancellation, refunds and lapsed subscriptions end access", async () => {
  const { org, fan, plan, operator } = await setup();
  const provider = new FakePaymentProvider();
  const { subscription } = await subscribe(org, { planId: plan.id, accountId: fan, consent, idempotencyKey: key() }, provider, urls);
  const providerSubscriptionId = `sub_${randomUUID()}`;
  await deliver({ kind: "subscription_checkout_completed", organizationId: org, subscriptionId: subscription.id, providerSubscriptionId });
  await deliver({ kind: "invoice_paid", providerSubscriptionId, organizationId: null, subscriptionId: null, invoiceId: `in_${randomUUID()}`, paymentReference: `pi_${randomUUID()}`, amountMinor: 500, currency: "USD", periodStart: new Date(Date.now() - day), periodEnd: new Date(Date.now() + day) });
  const [order] = await getSqlClient()<{ id: string }[]>`SELECT id FROM payment_orders WHERE organization_id = ${org} AND subject_id = ${subscription.id}`;
  await requestRefund({ organizationId: org, orderId: order!.id, reason: "requested_by_customer", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  assert.equal(await hasActiveSubscription(org, fan, plan.id), false, "full refund ends the paid access");

  const second = await createAccount(org);
  const s2 = await subscribe(org, { planId: plan.id, accountId: second, consent, idempotencyKey: key() }, provider, urls);
  const p2 = `sub_${randomUUID()}`;
  await deliver({ kind: "invoice_paid", providerSubscriptionId: p2, organizationId: org, subscriptionId: s2.subscription.id, invoiceId: `in_${randomUUID()}`, paymentReference: `pi_${randomUUID()}`, amountMinor: 500, currency: "USD", periodStart: new Date(Date.now() - day), periodEnd: new Date(Date.now() + day) });
  assert.equal(await hasActiveSubscription(org, second, plan.id), true);
  const now = await cancelSubscription(org, s2.subscription.id, { atPeriodEnd: false, actorAccountId: operator }, provider);
  assert.equal(now.status, "cancelled");
  assert.equal(await hasActiveSubscription(org, second, plan.id), false);

  const third = await createAccount(org);
  const s3 = await subscribe(org, { planId: plan.id, accountId: third, consent, idempotencyKey: key() }, provider, urls);
  await deliver({ kind: "invoice_paid", providerSubscriptionId: `sub_${randomUUID()}`, organizationId: org, subscriptionId: s3.subscription.id, invoiceId: `in_${randomUUID()}`, paymentReference: `pi_${randomUUID()}`, amountMinor: 500, currency: "USD", periodStart: new Date(Date.now() - 40 * day), periodEnd: new Date(Date.now() - 10 * day) });
  assert.equal(await expireLapsedSubscriptions(new Date(), 7, org), 1);
  assert.equal((await getSubscription(org, s3.subscription.id))?.status, "expired");
});

test("subscription and creator-membership flags gate plans at tenant and account scope", async () => {
  const { org, operator, fan, plan } = await setup();
  const tenantPlan = await createMembershipPlan(org, { creatorType: "tenant", creatorId: null, name: "Season pass", description: "", priceMinor: 9000, currency: "USD", interval: "year", termsVersion: "v1" }, operator);
  assert.equal((await listMembershipPlans(org)).length, 2);
  await setFeatureFlag({ scope: "tenant", organizationId: org, feature: "creator_memberships", enabled: false, expectedRevision: 1, actorAccountId: operator });
  assert.deepEqual((await listMembershipPlans(org)).map(p => p.id), [tenantPlan.id], "creator plans and their prices disappear");
  await assert.rejects(subscribe(org, { planId: plan.id, accountId: fan, consent, idempotencyKey: key() }, new FakePaymentProvider(), urls), /feature_disabled/);
  await setFeatureFlag({ scope: "account", organizationId: org, accountId: fan, feature: "subscriptions", enabled: false, expectedRevision: 0, actorAccountId: operator });
  assert.deepEqual(await listMembershipPlans(org, fan), []);
  await assert.rejects(subscribe(org, { planId: tenantPlan.id, accountId: fan, consent: { accepted: true, termsVersion: "v1", priceMinor: 9000, currency: "USD", interval: "year" }, idempotencyKey: key() }, new FakePaymentProvider(), urls), /feature_disabled/);
});

test("cross-tenant plans, subscriptions and provider events are isolated", async () => {
  const a = await setup();
  const b = await setup();
  const provider = new FakePaymentProvider();
  await assert.rejects(subscribe(b.org, { planId: a.plan.id, accountId: b.fan, consent, idempotencyKey: key() }, provider, urls), /plan_not_found/);
  const { subscription } = await subscribe(a.org, { planId: a.plan.id, accountId: a.fan, consent, idempotencyKey: key() }, provider, urls);
  await assert.rejects(cancelSubscription(b.org, subscription.id, { atPeriodEnd: false, actorAccountId: b.operator }, provider), /subscription_not_found/);
  const forged = await deliver({ kind: "invoice_paid", providerSubscriptionId: `sub_${randomUUID()}`, organizationId: b.org, subscriptionId: subscription.id, invoiceId: `in_${randomUUID()}`, paymentReference: null, amountMinor: 500, currency: "USD", periodStart: new Date(), periodEnd: new Date(Date.now() + day) });
  assert.equal(forged.outcome, "subscription_not_found");
  assert.equal((await getSubscription(a.org, subscription.id))?.status, "incomplete");
  await assert.rejects(createMembershipPlan(b.org, { creatorType: "account", creatorId: a.creator, name: "X", description: "", priceMinor: 1, currency: "USD", interval: "month", termsVersion: "v" }, b.operator), /scope denied|creator_not_found/);
});
