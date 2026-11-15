import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import { setFeatureFlag } from "./feature-flags.ts";
import { FakePaymentProvider } from "./providers/fake-payments.ts";
import { ingestPaymentEvent, requestRefund } from "./payments.ts";
import { fulfillmentHooks } from "./payment-fulfillment.ts";
import { createMembershipPlan, subscribe } from "./subscriptions.ts";
import { createContent, getContentForViewer, listContentForViewer, purchaseContent } from "./paywalls.ts";
import type { ContentInput } from "@live-competition-engine/domain/paywalls";

after(async () => { await closeDatabaseConnection(); });

const hooks = fulfillmentHooks();
const urls = () => ({ successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" });
const key = () => `test-${randomUUID()}`;
const day = 86_400_000;

async function setup(features = ["content_paywalls", "subscriptions", "creator_memberships"]) {
  const org = await createTenant("Paywall tenant");
  const operator = await createAccount(org);
  const creator = await createAccount(org);
  const fan = await createAccount(org);
  for (const feature of features) await enableFeature(feature, org, operator);
  return { org, operator, creator, fan };
}

const post = (creator: string, overrides: Partial<ContentInput> = {}): ContentInput => ({
  creatorType: "account", creatorId: creator, eventId: null, kind: "text", mediaId: null, title: "Behind the scenes",
  teaser: "A short preview", body: "The full supporter-only story.", accessRule: "public", planId: null, priceMinor: null, currency: null, ...overrides
});

const viewer = (accountId: string | null) => ({ accountId, isManager: false });

async function activeSupporter(org: string, planId: string, fan: string) {
  const { subscription } = await subscribe(org, { planId, accountId: fan, consent: { accepted: true, termsVersion: "v1", priceMinor: 300, currency: "USD", interval: "month" }, idempotencyKey: key() }, new FakePaymentProvider(), urls);
  await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "invoice.paid", rawBody: "{}", event: {
    kind: "invoice_paid", providerSubscriptionId: `sub_${randomUUID()}`, organizationId: org, subscriptionId: subscription.id, invoiceId: `in_${randomUUID()}`,
    paymentReference: `pi_${randomUUID()}`, amountMinor: 300, currency: "USD", periodStart: new Date(Date.now() - day), periodEnd: new Date(Date.now() + day)
  } }, hooks);
}

test("free publishing always works and gated items return teasers until entitled", async () => {
  const { org, creator, fan } = await setup();
  const plan = await createMembershipPlan(org, { creatorType: "account", creatorId: creator, name: "Supporters", description: "", priceMinor: 300, currency: "USD", interval: "month", termsVersion: "v1" }, creator);
  const free = await createContent(org, post(creator), creator);
  const members = await createContent(org, post(creator, { accessRule: "members" }), creator);
  const planOnly = await createContent(org, post(creator, { accessRule: "plan", planId: plan.id }), creator);

  assert.equal((await getContentForViewer(org, free.id, viewer(null)))?.body, "The full supporter-only story.");
  const teaser = await getContentForViewer(org, members.id, viewer(fan));
  assert.equal(teaser?.access, "teaser");
  assert.equal(teaser?.body, undefined);
  assert.deepEqual(teaser?.offer, { type: "members" });
  assert.deepEqual((await getContentForViewer(org, planOnly.id, viewer(fan)))?.offer, { type: "plan", planId: plan.id });
  assert.equal((await getContentForViewer(org, members.id, viewer(creator)))?.access, "full", "creators always see their own content");

  await activeSupporter(org, plan.id, fan);
  assert.equal((await getContentForViewer(org, members.id, viewer(fan)))?.access, "full");
  assert.equal((await getContentForViewer(org, planOnly.id, viewer(fan)))?.body, "The full supporter-only story.");
  const listed = await listContentForViewer(org, viewer(fan));
  assert.equal(listed.length, 3);
  assert.ok(listed.every(item => item.access === "full"));
});

test("purchased items unlock on payment and lock again after a full refund", async () => {
  const { org, creator, fan, operator } = await setup();
  const provider = new FakePaymentProvider();
  const item = await createContent(org, post(creator, { accessRule: "purchase", priceMinor: 250, currency: "USD" }), creator);
  assert.deepEqual((await getContentForViewer(org, item.id, viewer(fan)))?.offer, { type: "purchase", priceMinor: 250, currency: "USD" });
  await assert.rejects(purchaseContent(org, { itemId: item.id, accountId: creator, idempotencyKey: key() }, provider, urls), /forbidden/);
  const { order, redirectUrl } = await purchaseContent(org, { itemId: item.id, accountId: fan, idempotencyKey: key() }, provider, urls);
  assert.ok(redirectUrl);
  assert.equal((await getContentForViewer(org, item.id, viewer(fan)))?.access, "teaser", "no access before the provider confirms");
  await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_succeeded", organizationId: org, orderId: order.id, paymentReference: `pi_${randomUUID()}`, amountMinor: 250, currency: "USD" } }, hooks);
  assert.equal((await getContentForViewer(org, item.id, viewer(fan)))?.access, "full");
  await assert.rejects(purchaseContent(org, { itemId: item.id, accountId: fan, idempotencyKey: key() }, provider, urls), /already_purchased/);
  // Buying one item never unlocks other gated content.
  const members = await createContent(org, post(creator, { accessRule: "members" }), creator);
  assert.equal((await getContentForViewer(org, members.id, viewer(fan)))?.access, "teaser");
  await requestRefund({ organizationId: org, orderId: order.id, reason: "requested_by_customer", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  assert.equal((await getContentForViewer(org, item.id, viewer(fan)))?.access, "teaser");
});

test("disabled paywalls hide gated items (no price) but never block free publishing", async () => {
  const { org, creator, fan, operator } = await setup();
  const event = await createCompetition(org);
  const gated = await createContent(org, post(creator, { accessRule: "purchase", priceMinor: 100, currency: "USD" }), creator);
  const archive = await createContent(org, post(creator, { accessRule: "members", eventId: event }), creator);
  // Event-level veto: only the event archive disappears.
  await setFeatureFlag({ scope: "event", organizationId: org, eventId: event, feature: "content_paywalls", enabled: false, expectedRevision: 0, actorAccountId: operator });
  assert.equal(await getContentForViewer(org, archive.id, viewer(fan)), null);
  assert.equal((await getContentForViewer(org, gated.id, viewer(fan)))?.access, "teaser");
  // Creator opts out at account scope: their gated items are hidden, not given away.
  await setFeatureFlag({ scope: "account", organizationId: org, accountId: creator, feature: "content_paywalls", enabled: false, expectedRevision: 0, actorAccountId: operator });
  assert.equal(await getContentForViewer(org, gated.id, viewer(fan)), null);
  await assert.rejects(createContent(org, post(creator, { accessRule: "members" }), creator), /feature_disabled/);
  const free = await createContent(org, post(creator), creator);
  assert.equal((await getContentForViewer(org, free.id, viewer(fan)))?.access, "full");
  // Tenant-level veto.
  await setFeatureFlag({ scope: "tenant", organizationId: org, feature: "content_paywalls", enabled: false, expectedRevision: 1, actorAccountId: operator });
  const listed = await listContentForViewer(org, viewer(fan));
  assert.deepEqual(listed.map(v => v.id), [free.id]);
  assert.ok(!JSON.stringify(listed).includes("priceMinor"));
  await assert.rejects(purchaseContent(org, { itemId: gated.id, accountId: fan, idempotencyKey: key() }, new FakePaymentProvider(), urls), /feature_disabled/);
});

test("cross-tenant content reads, purchases and plan references are denied", async () => {
  const a = await setup();
  const b = await setup();
  const item = await createContent(a.org, post(a.creator, { accessRule: "purchase", priceMinor: 100, currency: "USD" }), a.creator);
  assert.equal(await getContentForViewer(b.org, item.id, viewer(b.fan)), null);
  await assert.rejects(purchaseContent(b.org, { itemId: item.id, accountId: b.fan, idempotencyKey: key() }, new FakePaymentProvider(), urls), /content_not_found/);
  const planA = await createMembershipPlan(a.org, { creatorType: "tenant", creatorId: null, name: "A", description: "", priceMinor: 100, currency: "USD", interval: "month", termsVersion: "v1" }, a.operator);
  await assert.rejects(createContent(b.org, post(b.creator, { accessRule: "plan", planId: planA.id }), b.creator), /plan_not_found/);
  const rows = await getSqlClient()`SELECT 1 FROM gated_content WHERE organization_id = ${b.org}`;
  assert.equal(rows.length, 0);
});
