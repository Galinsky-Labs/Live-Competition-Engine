import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import { setFeatureFlag } from "./feature-flags.ts";
import { FakePaymentProvider } from "./providers/fake-payments.ts";
import { getPaymentOrder, ingestPaymentEvent, ledgerTrialBalance, requestRefund } from "./payments.ts";
import { fulfillmentHooks } from "./payment-fulfillment.ts";
import { grantsForSource } from "./entitlement-grants.ts";
import {
  checkEventAccess,
  createTicketType,
  entryFeeGate,
  hasPaidEntryFee,
  listTicketTypes,
  purchaseEntryFee,
  purchaseTicket,
  releaseExpiredHolds,
  revokeTicket,
  setEntryFee
} from "./ticketing.ts";

after(async () => { await closeDatabaseConnection(); });

const hooks = fulfillmentHooks();
const urls = () => ({ successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" });
const key = () => `test-${randomUUID()}`;

async function setup(features: string[] = ["ticketing", "ppv", "entry_fees"]) {
  const org = await createTenant("Ticketing tenant");
  const operator = await createAccount(org);
  const event = await createCompetition(org);
  for (const feature of features) await enableFeature(feature, org, operator);
  return { org, operator, event };
}

const ticket = (overrides: Record<string, unknown> = {}) => ({
  kind: "ticket" as const, name: "General admission", priceMinor: 1500, currency: "USD", capacity: 5,
  salesStartsAt: null, salesEndsAt: null, ...overrides
});

async function succeed(org: string, orderId: string, amount: number, currency = "USD") {
  return ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_succeeded", organizationId: org, orderId, paymentReference: `pi_${randomUUID()}`, amountMinor: amount, currency } }, hooks);
}

const reserved = async (id: string) => Number((await getSqlClient()<{ reserved: number }[]>`SELECT reserved FROM ticket_types WHERE id = ${id}`)[0]!.reserved);

test("paid ticket: checkout, success issues event.enter, full refund revokes it and frees the seat", async () => {
  const { org, operator, event } = await setup();
  const buyer = await createAccount(org);
  const provider = new FakePaymentProvider();
  const type = await createTicketType(org, event, ticket(), operator);
  assert.deepEqual(await checkEventAccess(org, event, buyer, "enter"), { gated: true, allowed: false });
  const { order, redirectUrl } = await purchaseTicket(org, { eventId: event, ticketTypeId: type.id, accountId: buyer, idempotencyKey: key() }, provider, urls, hooks);
  assert.ok(redirectUrl?.startsWith("https://payments.fake.invalid/"));
  assert.equal(order.status, "processing");
  assert.equal(await reserved(type.id), 1);
  assert.equal((await succeed(org, order.id, 1500)).outcome, "succeeded");
  assert.deepEqual(await checkEventAccess(org, event, buyer, "enter"), { gated: true, allowed: true });
  assert.deepEqual(await checkEventAccess(org, event, buyer, "view"), { gated: false, allowed: true });
  assert.deepEqual((await grantsForSource(org, "payment_order", order.id)).map(g => [g.capability, g.status]), [["event.enter", "active"]]);

  await requestRefund({ organizationId: org, orderId: order.id, amountMinor: 500, reason: "operator", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  assert.equal((await checkEventAccess(org, event, buyer, "enter")).allowed, true, "partial refund keeps the ticket");
  await requestRefund({ organizationId: org, orderId: order.id, reason: "operator", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  assert.equal((await checkEventAccess(org, event, buyer, "enter")).allowed, false);
  assert.deepEqual((await grantsForSource(org, "payment_order", order.id)).map(g => g.status), ["refunded"]);
  assert.equal(await reserved(type.id), 0);
  assert.deepEqual(await ledgerTrialBalance(org), { USD: 0 });
});

test("concurrent buyers never oversell capacity", async () => {
  const { org, operator, event } = await setup(["ticketing"]);
  const provider = new FakePaymentProvider();
  const type = await createTicketType(org, event, ticket({ capacity: 3 }), operator);
  const buyers = await Promise.all(Array.from({ length: 12 }, () => createAccount(org)));
  const results = await Promise.allSettled(buyers.map(buyer =>
    purchaseTicket(org, { eventId: event, ticketTypeId: type.id, accountId: buyer, idempotencyKey: key() }, provider, urls, hooks)));
  const ok = results.filter(r => r.status === "fulfilled");
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(ok.length, 3);
  assert.ok(rejected.every(r => /sold_out/.test(String(r.reason))));
  assert.equal(await reserved(type.id), 3);
  // The same buyer racing two purchases gets at most one live ticket.
  const type2 = await createTicketType(org, event, ticket({ capacity: 10 }), operator);
  const twice = await Promise.allSettled([1, 2].map(() =>
    purchaseTicket(org, { eventId: event, ticketTypeId: type2.id, accountId: buyers[0]!, idempotencyKey: key() }, provider, urls, hooks)));
  assert.equal(twice.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await reserved(type2.id), 1);
});

test("failed payments and expired holds release capacity; idempotent retries resume the order", async () => {
  const { org, operator, event } = await setup(["ticketing"]);
  const provider = new FakePaymentProvider();
  const type = await createTicketType(org, event, ticket({ capacity: 1 }), operator);
  const buyer = await createAccount(org);
  const k = key();
  const first = await purchaseTicket(org, { eventId: event, ticketTypeId: type.id, accountId: buyer, idempotencyKey: k }, provider, urls, hooks);
  const retry = await purchaseTicket(org, { eventId: event, ticketTypeId: type.id, accountId: buyer, idempotencyKey: k }, provider, urls, hooks);
  assert.equal(retry.order.id, first.order.id);
  assert.equal(await reserved(type.id), 1);
  await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_failed", organizationId: org, orderId: first.order.id, failureCode: "card_declined" } }, hooks);
  assert.equal(await reserved(type.id), 0);

  const other = await createAccount(org);
  const held = await purchaseTicket(org, { eventId: event, ticketTypeId: type.id, accountId: other, idempotencyKey: key() }, provider, urls, hooks);
  await assert.rejects(purchaseTicket(org, { eventId: event, ticketTypeId: type.id, accountId: buyer, idempotencyKey: key() }, provider, urls, hooks), /sold_out/);
  assert.ok(await releaseExpiredHolds(new Date(Date.now() + 41 * 60_000), { organizationId: org, hooks }) >= 1);
  assert.equal((await getPaymentOrder(org, held.order.id))?.status, "cancelled");
  assert.equal(await reserved(type.id), 0);
});

test("free tickets complete without a provider call or ledger posting; sales windows are enforced", async () => {
  const { org, operator, event } = await setup(["ticketing"]);
  const provider = new FakePaymentProvider();
  const buyer = await createAccount(org);
  const free = await createTicketType(org, event, ticket({ priceMinor: 0, capacity: null }), operator);
  const result = await purchaseTicket(org, { eventId: event, ticketTypeId: free.id, accountId: buyer, idempotencyKey: key() }, provider, urls, hooks);
  assert.equal(result.order.status, "succeeded");
  assert.equal(result.redirectUrl, null);
  assert.equal(provider.calls, 0);
  assert.deepEqual(await ledgerTrialBalance(org), {});
  assert.equal((await checkEventAccess(org, event, buyer, "enter")).allowed, true);
  assert.equal(await revokeTicket(org, result.order.id, operator), 1);
  assert.equal((await checkEventAccess(org, event, buyer, "enter")).allowed, false);
  const later = await createTicketType(org, event, ticket({ salesStartsAt: new Date(Date.now() + 86_400_000) }), operator);
  await assert.rejects(purchaseTicket(org, { eventId: event, ticketTypeId: later.id, accountId: buyer, idempotencyKey: key() }, provider, urls, hooks), /sales_closed/);
});

test("PPV issues event.view and is toggled independently of ticketing at every scope", async () => {
  const { org, operator, event } = await setup(["ticketing", "ppv"]);
  const provider = new FakePaymentProvider();
  const buyer = await createAccount(org);
  const ppv = await createTicketType(org, event, ticket({ kind: "ppv", name: "Stream", priceMinor: 700, capacity: null }), operator);
  await createTicketType(org, event, ticket(), operator);
  const { order } = await purchaseTicket(org, { eventId: event, ticketTypeId: ppv.id, accountId: buyer, idempotencyKey: key() }, provider, urls, hooks);
  await succeed(org, order.id, 700);
  assert.deepEqual(await checkEventAccess(org, event, buyer, "view"), { gated: true, allowed: true });
  assert.equal((await checkEventAccess(org, event, buyer, "enter")).allowed, false);

  // Event-level veto of ticketing hides ticket prices but leaves PPV untouched.
  await setFeatureFlag({ scope: "event", organizationId: org, eventId: event, feature: "ticketing", enabled: false, expectedRevision: 0, actorAccountId: operator });
  assert.deepEqual((await listTicketTypes(org, event)).map(t => t.kind), ["ppv"]);
  assert.deepEqual(await checkEventAccess(org, event, buyer, "enter"), { gated: false, allowed: true });
  await assert.rejects(createTicketType(org, event, ticket(), operator), /feature_disabled/);

  // Account-level veto of PPV for one viewer.
  const other = await createAccount(org);
  await setFeatureFlag({ scope: "account", organizationId: org, accountId: other, feature: "ppv", enabled: false, expectedRevision: 0, actorAccountId: operator });
  await assert.rejects(purchaseTicket(org, { eventId: event, ticketTypeId: ppv.id, accountId: other, idempotencyKey: key() }, provider, urls, hooks), /feature_disabled/);
  assert.deepEqual(await listTicketTypes(org, event, other), []);

  // Tenant-level veto of PPV removes it for everyone.
  await setFeatureFlag({ scope: "tenant", organizationId: org, feature: "ppv", enabled: false, expectedRevision: 1, actorAccountId: operator });
  assert.deepEqual(await listTicketTypes(org, event), []);
  assert.deepEqual(await checkEventAccess(org, event, buyer, "view"), { gated: false, allowed: true });
});

test("entry fees: gate, payment, refund and opt-out", async () => {
  const { org, operator, event } = await setup(["entry_fees"]);
  const provider = new FakePaymentProvider();
  const applicant = await createAccount(org);
  assert.deepEqual(await entryFeeGate(org, event, applicant), { required: false });
  await setEntryFee(org, event, { priceMinor: 2500, currency: "eur", active: true, expectedRevision: 0 }, operator);
  await assert.rejects(setEntryFee(org, event, { priceMinor: 2500, currency: "eur", active: true, expectedRevision: 0 }, operator), /revision_conflict/);
  assert.deepEqual(await entryFeeGate(org, event, applicant), { required: true, paid: false, priceMinor: 2500, currency: "EUR" });
  const { order } = await purchaseEntryFee(org, { competitionId: event, accountId: applicant, idempotencyKey: key() }, provider, urls);
  await succeed(org, order.id, 2500, "EUR");
  assert.equal(await hasPaidEntryFee(org, event, applicant), true);
  await assert.rejects(purchaseEntryFee(org, { competitionId: event, accountId: applicant, idempotencyKey: key() }, provider, urls), /already_paid/);
  await requestRefund({ organizationId: org, orderId: order.id, reason: "event_cancelled", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  assert.equal(await hasPaidEntryFee(org, event, applicant), false);
  await setFeatureFlag({ scope: "event", organizationId: org, eventId: event, feature: "entry_fees", enabled: false, expectedRevision: 0, actorAccountId: operator });
  assert.deepEqual(await entryFeeGate(org, event, applicant), { required: false });
  await assert.rejects(purchaseEntryFee(org, { competitionId: event, accountId: applicant, idempotencyKey: key() }, provider, urls), /feature_disabled/);
});

test("cross-tenant ticket purchases, access checks and entry-fee lookups are denied", async () => {
  const a = await setup(["ticketing", "entry_fees"]);
  const b = await setup(["ticketing", "entry_fees"]);
  const provider = new FakePaymentProvider();
  const type = await createTicketType(a.org, a.event, ticket(), a.operator);
  const outsider = await createAccount(b.org);
  await assert.rejects(purchaseTicket(b.org, { eventId: a.event, ticketTypeId: type.id, accountId: outsider, idempotencyKey: key() }, provider, urls, hooks), /ticket_type_not_found/);
  await assert.rejects(createTicketType(b.org, a.event, ticket(), b.operator), /forbidden|scope denied|feature_disabled|violates/);
  assert.equal(await hasPaidEntryFee(b.org, a.event, outsider), false);
  await assert.rejects(revokeTicket(b.org, randomUUID(), b.operator), /order_not_found/);
  assert.deepEqual(await listTicketTypes(b.org, b.event), []);
});
