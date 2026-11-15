import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection } from "./index.ts";
import { createAccount, createCompetition, createEntry, createTenant, enableFeature } from "./test-fixtures.ts";
import { setFeatureFlag } from "./feature-flags.ts";
import { FakePaymentProvider } from "./providers/fake-payments.ts";
import { ingestPaymentEvent, ledgerBalances, ledgerTrialBalance, requestRefund } from "./payments.ts";
import { fulfillmentHooks } from "./payment-fulfillment.ts";
import { createSplitRule } from "./revenue-splits.ts";
import { createGift, linkParticipantPayoutAccount, listEventTips, listGifts, quoteTip, sendTip, setTipPolicy } from "./tips.ts";

after(async () => { await closeDatabaseConnection(); });

const hooks = fulfillmentHooks();
const urls = () => ({ successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" });
const key = () => `test-${randomUUID()}`;

async function setup() {
  const org = await createTenant("Tips tenant");
  const operator = await createAccount(org);
  const fan = await createAccount(org);
  const performerAccount = await createAccount(org);
  const event = await createCompetition(org);
  const { participantId } = await createEntry(org, event);
  await enableFeature("tips_gifts", org, operator);
  await linkParticipantPayoutAccount(org, participantId, performerAccount, operator);
  return { org, operator, fan, performerAccount, event, participantId };
}

const balances = async (org: string) => Object.fromEntries((await ledgerBalances(org)).map(b => [b.code, b.balanceMinor]));

async function pay(org: string, orderId: string, amount: number, reference = `pi_${randomUUID()}`) {
  await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_succeeded", organizationId: org, orderId, paymentReference: reference, amountMinor: amount, currency: "USD" } }, hooks);
  return reference;
}

test("fee-transparent quote, confirmed tip, payee ledger credit and refund reversal", async () => {
  const { org, operator, fan, event, participantId } = await setup();
  const provider = new FakePaymentProvider();
  await createSplitRule(org, { purpose: "tip", lines: [{ partyType: "platform", bps: 500 }, { partyType: "tenant", bps: 500 }, { partyType: "payee" }], remainderLine: 2 }, operator);
  const request = { eventId: event, payeeType: "participant" as const, payeeId: participantId, amountMinor: 1000, currency: "usd" };
  const quote = await quoteTip(org, request, fan);
  assert.equal(quote.grossMinor, 1000);
  assert.equal(quote.payeeMinor, 900);
  assert.deepEqual(quote.fees.map(f => [f.partyType, f.amountMinor]), [["platform", 50], ["tenant", 50]]);

  await assert.rejects(sendTip(org, { ...request, senderAccountId: fan, expected: { grossMinor: 1000, payeeMinor: 950 }, idempotencyKey: key() }, provider, urls), /quote_changed/);
  const sent = await sendTip(org, { ...request, senderAccountId: fan, expected: quote, message: "Great set!", idempotencyKey: key() }, provider, urls);
  assert.ok(sent.redirectUrl);
  assert.equal((await listEventTips(org, event)).length, 0, "unpaid tips are not shown");
  const reference = await pay(org, sent.order.id, 1000);
  const after = await balances(org);
  assert.equal(after[`payable:participant:${participantId}`], -900);
  assert.equal(after.platform_revenue, -50);
  assert.equal((await listEventTips(org, event))[0]?.message, "Great set!");

  await requestRefund({ organizationId: org, orderId: sent.order.id, reason: "requested_by_customer", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  const refunded = await balances(org);
  assert.equal(refunded[`payable:participant:${participantId}`], 0);
  assert.equal(refunded.provider_clearing, 0);
  assert.deepEqual(await ledgerTrialBalance(org), { USD: 0 });
  assert.equal((await listEventTips(org, event)).length, 0);

  // Chargeback on a second tip reverses the payee credit too.
  const second = await sendTip(org, { ...request, senderAccountId: fan, expected: quote, idempotencyKey: key() }, provider, urls);
  const ref2 = await pay(org, second.order.id, 1000);
  await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "charge.dispute.created", rawBody: "{}",
    event: { kind: "chargeback", paymentReference: ref2, amountMinor: 1000, currency: "USD", disputeId: `dp_${randomUUID()}` } }, hooks);
  assert.equal((await balances(org))[`payable:participant:${participantId}`], 0);
  assert.ok(reference);
});

test("self-tipping is blocked directly and through a participant's payout account", async () => {
  const { org, fan, event, participantId, performerAccount } = await setup();
  await assert.rejects(quoteTip(org, { eventId: event, payeeType: "account", payeeId: fan, amountMinor: 500, currency: "USD" }, fan), /self_tip_forbidden/);
  await assert.rejects(quoteTip(org, { eventId: event, payeeType: "participant", payeeId: participantId, amountMinor: 500, currency: "USD" }, performerAccount), /self_tip_forbidden/);
  const ok = await quoteTip(org, { eventId: event, payeeType: "account", payeeId: performerAccount, amountMinor: 500, currency: "USD" }, fan);
  assert.equal(ok.payeeMinor, 500, "default rule pays the payee in full");
});

test("amount bounds and per-sender velocity caps hold under concurrency", async () => {
  const { org, operator, fan, event, participantId } = await setup();
  const provider = new FakePaymentProvider();
  await setTipPolicy(org, { minMinor: 100, maxMinor: 2000, windowSeconds: 3600, maxCountPerWindow: 3, maxAmountPerWindowMinor: 5000 }, operator);
  const request = { eventId: event, payeeType: "participant" as const, payeeId: participantId, currency: "USD" };
  await assert.rejects(quoteTip(org, { ...request, amountMinor: 99 }, fan), /tip_amount_out_of_range/);
  await assert.rejects(quoteTip(org, { ...request, amountMinor: 2001 }, fan), /tip_amount_out_of_range/);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () =>
    sendTip(org, { ...request, amountMinor: 500, senderAccountId: fan, expected: { grossMinor: 500, payeeMinor: 500 }, idempotencyKey: key() }, provider, urls)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 3);
  assert.ok(results.filter((r): r is PromiseRejectedResult => r.status === "rejected").every(r => /rate_limited/.test(String(r.reason))));
  // Amount cap: another sender sends 2000 + 2000, then a third 2000 exceeds 5000.
  const whale = await createAccount(org);
  for (let i = 0; i < 2; i += 1) {
    await sendTip(org, { ...request, amountMinor: 2000, senderAccountId: whale, expected: { grossMinor: 2000, payeeMinor: 2000 }, idempotencyKey: key() }, provider, urls);
  }
  await assert.rejects(sendTip(org, { ...request, amountMinor: 2000, senderAccountId: whale, expected: { grossMinor: 2000, payeeMinor: 2000 }, idempotencyKey: key() }, provider, urls), /rate_limited/);
});

test("gifts are priced from the tenant catalog and toggled with tips_gifts at every scope", async () => {
  const { org, operator, fan, event, participantId } = await setup();
  const provider = new FakePaymentProvider();
  const rose = await createGift(org, { name: "Rose", priceMinor: 300, currency: "usd" }, operator);
  assert.deepEqual((await listGifts(org)).map(g => g.name), ["Rose"]);
  const request = { eventId: event, payeeType: "participant" as const, payeeId: participantId, giftId: rose.id, quantity: 3 };
  const quote = await quoteTip(org, request, fan);
  assert.equal(quote.grossMinor, 900);
  const sent = await sendTip(org, { ...request, senderAccountId: fan, expected: quote, idempotencyKey: key() }, provider, urls);
  assert.equal(sent.order.purpose, "gift");
  assert.equal(sent.order.amountMinor, 900);

  const other = await createAccount(org);
  await setFeatureFlag({ scope: "account", organizationId: org, accountId: other, feature: "tips_gifts", enabled: false, expectedRevision: 0, actorAccountId: operator });
  await assert.rejects(quoteTip(org, request, other), /feature_disabled/);
  assert.deepEqual(await listGifts(org, { accountId: other }), []);
  await setFeatureFlag({ scope: "event", organizationId: org, eventId: event, feature: "tips_gifts", enabled: false, expectedRevision: 0, actorAccountId: operator });
  await assert.rejects(quoteTip(org, request, fan), /feature_disabled/);
  assert.deepEqual(await listGifts(org, { eventId: event }), []);
  await setFeatureFlag({ scope: "tenant", organizationId: org, feature: "tips_gifts", enabled: false, expectedRevision: 1, actorAccountId: operator });
  assert.deepEqual(await listGifts(org), []);
  await assert.rejects(createGift(org, { name: "Star", priceMinor: 100, currency: "USD" }, operator), /feature_disabled/);
});

test("cross-tenant payees and gifts are rejected", async () => {
  const a = await setup();
  const b = await setup();
  const giftA = await createGift(a.org, { name: "Rose", priceMinor: 300, currency: "USD" }, a.operator);
  await assert.rejects(quoteTip(b.org, { eventId: b.event, payeeType: "participant", payeeId: a.participantId, amountMinor: 500, currency: "USD" }, b.fan), /payee_not_found/);
  await assert.rejects(quoteTip(b.org, { eventId: b.event, payeeType: "participant", payeeId: b.participantId, giftId: giftA.id }, b.fan), /gift_not_found/);
  await assert.rejects(quoteTip(b.org, { eventId: a.event, payeeType: "participant", payeeId: a.participantId, amountMinor: 500, currency: "USD" }, b.fan), /scope denied/);
  await assert.rejects(quoteTip(b.org, { eventId: b.event, payeeType: "account", payeeId: a.fan, amountMinor: 500, currency: "USD" }, b.fan), /payee_not_found/);
});
