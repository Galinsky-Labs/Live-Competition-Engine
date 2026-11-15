import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createTenant } from "./test-fixtures.ts";
import { FakePaymentProvider } from "./providers/fake-payments.ts";
import {
  cancelPaymentOrder,
  createPaymentOrder,
  getPaymentOrder,
  ingestPaymentEvent,
  ledgerBalances,
  ledgerTrialBalance,
  listOrderRefunds,
  postLedgerTransaction,
  reconcilePayments,
  requestRefund,
  reverseLedgerTransaction,
  startCheckout
} from "./payments.ts";
import { verifyAuditChain } from "./audit.ts";

after(async () => { await closeDatabaseConnection(); });

const key = () => `test-${randomUUID()}`;

async function paidOrder(provider: FakePaymentProvider, amount = 1000) {
  const org = await createTenant("Payments tenant");
  const buyer = await createAccount(org);
  const { order } = await getSqlClient().begin(tx => createPaymentOrder(tx, {
    organizationId: org, accountId: buyer, purpose: "ticket", description: "Admission", amountMinor: amount,
    currency: "usd", provider: "fake", idempotencyKey: key()
  }));
  const checkout = await startCheckout(org, order.id, provider, { successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" });
  assert.equal(checkout.order.status, "processing");
  const paymentReference = `fake_pi_${order.id}`;
  provider.recordCharge(paymentReference, amount, "USD");
  const result = await ingestPaymentEvent("fake", {
    eventId: `evt_${randomUUID()}`, eventType: "checkout.session.completed", rawBody: "{}",
    event: { kind: "payment_succeeded", organizationId: org, orderId: order.id, paymentReference, amountMinor: amount, currency: "USD" }
  });
  assert.equal(result.outcome, "succeeded");
  return { org, buyer, orderId: order.id, paymentReference };
}

const balance = async (org: string, code: string) =>
  (await ledgerBalances(org)).find(b => b.code === code)?.balanceMinor ?? 0;

test("successful payment posts a balanced ledger transaction and audit entry", async () => {
  const provider = new FakePaymentProvider();
  const { org, orderId } = await paidOrder(provider, 2500);
  const order = await getPaymentOrder(org, orderId);
  assert.equal(order?.status, "succeeded");
  assert.equal(order?.settlementStatus, "settled");
  assert.equal(await balance(org, "provider_clearing"), 2500);
  assert.equal(await balance(org, "sales_clearing"), -2500);
  assert.deepEqual(await ledgerTrialBalance(org), { USD: 0 });
  assert.equal((await verifyAuditChain(org)).valid, true);
  const actions = await getSqlClient()<{ action: string }[]>`SELECT action FROM audit_events WHERE organization_id = ${org} ORDER BY sequence`;
  assert.deepEqual(actions.map(a => a.action), ["payment.order_created", "payment.succeeded"]);
});

test("replayed webhook deliveries are ignored", async () => {
  const provider = new FakePaymentProvider();
  const { org, orderId, paymentReference } = await paidOrder(provider, 700);
  const eventId = `evt_${randomUUID()}`;
  const event = { kind: "payment_succeeded" as const, organizationId: org, orderId, paymentReference, amountMinor: 700, currency: "USD" };
  const first = await ingestPaymentEvent("fake", { eventId, eventType: "checkout.session.completed", rawBody: "{}", event });
  assert.equal(first.outcome, "already_succeeded");
  const replay = await ingestPaymentEvent("fake", { eventId, eventType: "checkout.session.completed", rawBody: "{}", event });
  assert.deepEqual(replay, { duplicate: true, outcome: "duplicate" });
  // Concurrent duplicate deliveries: exactly one is processed.
  const concurrentId = `evt_${randomUUID()}`;
  const results = await Promise.all([1, 2, 3].map(() => ingestPaymentEvent("fake", { eventId: concurrentId, eventType: "x", rawBody: "{}", event })));
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  const txns = await getSqlClient()`SELECT 1 FROM ledger_transactions WHERE organization_id = ${org} AND kind = 'payment'`;
  assert.equal(txns.length, 1);
});

test("failed and cancelled payments never post money and stay terminal", async () => {
  const provider = new FakePaymentProvider();
  const org = await createTenant();
  const buyer = await createAccount(org);
  const sql = getSqlClient();
  const { order } = await sql.begin(tx => createPaymentOrder(tx, {
    organizationId: org, accountId: buyer, purpose: "ppv", description: "Stream", amountMinor: 900, currency: "EUR", provider: "fake", idempotencyKey: key()
  }));
  await startCheckout(org, order.id, provider, { successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" });
  const failed = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_failed", organizationId: org, orderId: order.id, failureCode: "card_declined" } });
  assert.equal(failed.outcome, "failed");
  const late = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_succeeded", organizationId: org, orderId: order.id, paymentReference: "pi_late", amountMinor: 900, currency: "EUR" } });
  assert.equal(late.outcome, "invalid_state");
  assert.deepEqual(await ledgerTrialBalance(org), {});
  assert.equal((await getPaymentOrder(org, order.id))?.status, "failed");

  const { order: second } = await sql.begin(tx => createPaymentOrder(tx, {
    organizationId: org, accountId: buyer, purpose: "ppv", description: "Stream", amountMinor: 900, currency: "EUR", provider: "fake", idempotencyKey: key()
  }));
  assert.equal((await cancelPaymentOrder(org, second.id)).status, "cancelled");
  await assert.rejects(startCheckout(org, second.id, provider, { successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" }), /invalid_state_order_closed/);

  const { order: third } = await sql.begin(tx => createPaymentOrder(tx, {
    organizationId: org, accountId: buyer, purpose: "ppv", description: "Stream", amountMinor: 900, currency: "EUR", provider: "fake", idempotencyKey: key()
  }));
  const mismatch = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_succeeded", organizationId: org, orderId: third.id, paymentReference: `pi_${randomUUID()}`, amountMinor: 1, currency: "EUR" } });
  assert.equal(mismatch.outcome, "amount_mismatch");
  assert.equal((await getPaymentOrder(org, third.id))?.failureCode, "amount_mismatch");
});

test("order idempotency returns the same order and rejects a changed request", async () => {
  const org = await createTenant();
  const buyer = await createAccount(org);
  const k = key();
  const input = { organizationId: org, accountId: buyer, purpose: "ticket" as const, description: "A", amountMinor: 100, currency: "USD", provider: "fake" as const, idempotencyKey: k };
  const sql = getSqlClient();
  const [a, b] = await Promise.all([sql.begin(tx => createPaymentOrder(tx, input)), sql.begin(tx => createPaymentOrder(tx, input))]);
  assert.equal(a.order.id, b.order.id);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  await assert.rejects(sql.begin(tx => createPaymentOrder(tx, { ...input, amountMinor: 101 })), /idempotency_conflict/);
});

test("partial and full refunds post to the ledger and cannot exceed the capture", async () => {
  const provider = new FakePaymentProvider();
  const { org, orderId, buyer } = await paidOrder(provider, 1000);
  const partial = await requestRefund({ organizationId: org, orderId, amountMinor: 300, reason: "requested_by_customer", actorAccountId: buyer, idempotencyKey: key() }, provider);
  assert.equal(partial.status, "succeeded");
  assert.equal((await getPaymentOrder(org, orderId))?.settlementStatus, "partially_refunded");
  await assert.rejects(requestRefund({ organizationId: org, orderId, amountMinor: 701, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider), /refund_exceeds_remaining/);
  // Concurrent refunds racing for the remaining 700: never more than the capture.
  const attempts = await Promise.allSettled([1, 2, 3].map(() =>
    requestRefund({ organizationId: org, orderId, amountMinor: 400, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider)));
  assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1);
  const rest = await requestRefund({ organizationId: org, orderId, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider);
  assert.equal(rest.amountMinor, 300);
  const order = await getPaymentOrder(org, orderId);
  assert.equal(order?.settlementStatus, "refunded");
  assert.equal(order?.refundedMinor, 1000);
  assert.equal(await balance(org, "provider_clearing"), 0);
  assert.deepEqual(await ledgerTrialBalance(org), { USD: 0 });
  assert.equal((await listOrderRefunds(org, orderId)).length, 3);
});

test("refund failure and pending refunds resolved by webhook", async () => {
  const provider = new FakePaymentProvider();
  const { org, orderId, buyer } = await paidOrder(provider, 1000);
  provider.refundOutcome = "failed";
  const failed = await requestRefund({ organizationId: org, orderId, amountMinor: 100, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider);
  assert.equal(failed.status, "failed");
  provider.refundOutcome = "pending";
  const pending = await requestRefund({ organizationId: org, orderId, amountMinor: 200, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider);
  assert.equal(pending.status, "pending");
  assert.equal(await balance(org, "provider_clearing"), 1000);
  const done = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "refund.updated", rawBody: "{}",
    event: { kind: "refund_updated", organizationId: org, refundId: pending.id, providerRefundReference: pending.providerRefundReference!, status: "succeeded" } });
  assert.equal(done.outcome, "refund_succeeded");
  assert.equal(await balance(org, "provider_clearing"), 800);
  // Provider outage leaves the refund pending (never silently failed or doubled).
  provider.failNextCall = true;
  const unknown = await requestRefund({ organizationId: org, orderId, amountMinor: 50, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider);
  assert.equal(unknown.status, "pending");
});

test("chargebacks reverse the remaining captured amount once", async () => {
  const provider = new FakePaymentProvider();
  const { org, orderId, paymentReference } = await paidOrder(provider, 1200);
  const disputeId = `dp_${randomUUID()}`;
  const first = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "charge.dispute.created", rawBody: "{}",
    event: { kind: "chargeback", paymentReference, amountMinor: 1200, currency: "USD", disputeId } });
  assert.equal(first.outcome, "chargeback_reversed");
  const again = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "charge.dispute.created", rawBody: "{}",
    event: { kind: "chargeback", paymentReference, amountMinor: 1200, currency: "USD", disputeId } });
  assert.equal(again.outcome, "nothing_to_reverse");
  assert.equal((await getPaymentOrder(org, orderId))?.settlementStatus, "refunded");
});

test("the database rejects imbalanced, mixed-currency and mutated journal entries", async () => {
  const org = await createTenant();
  const sql = getSqlClient();
  await assert.rejects(sql.begin(tx => postLedgerTransaction(tx, {
    organizationId: org, currency: "USD", kind: "adjustment", idempotencyKey: key(), sourceType: "test",
    lines: [{ accountCode: "tenant_revenue", amountMinor: 10 }, { accountCode: "fees", amountMinor: -9 }]
  })), /ledger_unbalanced/);
  // Bypass the service: the deferred trigger still rejects at commit.
  await assert.rejects(sql.begin(async tx => {
    const [account] = await tx<{ id: string }[]>`INSERT INTO ledger_accounts (organization_id, code, currency, kind) VALUES (${org}, 'fees', 'USD', 'expense') RETURNING id`;
    const [t] = await tx<{ id: string }[]>`INSERT INTO ledger_transactions (organization_id, currency, kind, idempotency_key, source_type) VALUES (${org}, 'USD', 'adjustment', ${key()}, 'test') RETURNING id`;
    await tx`INSERT INTO ledger_entries (organization_id, transaction_id, ledger_account_id, currency, amount_minor) VALUES (${org}, ${t!.id}, ${account!.id}, 'USD', 5)`;
  }), /ledger_unbalanced/);
  await assert.rejects(sql.begin(async tx => {
    const usd = await tx<{ id: string }[]>`INSERT INTO ledger_accounts (organization_id, code, currency, kind) VALUES (${org}, 'fees', 'GBP', 'expense') ON CONFLICT DO NOTHING RETURNING id`;
    const eur = await tx<{ id: string }[]>`INSERT INTO ledger_accounts (organization_id, code, currency, kind) VALUES (${org}, 'refunds', 'USD', 'expense') RETURNING id`;
    const [t] = await tx<{ id: string }[]>`INSERT INTO ledger_transactions (organization_id, currency, kind, idempotency_key, source_type) VALUES (${org}, 'USD', 'adjustment', ${key()}, 'test') RETURNING id`;
    await tx`INSERT INTO ledger_entries (organization_id, transaction_id, ledger_account_id, currency, amount_minor) VALUES (${org}, ${t!.id}, ${usd[0]!.id}, 'USD', 5), (${org}, ${t!.id}, ${eur[0]!.id}, 'USD', -5)`;
  }), /ledger_currency_mismatch/);

  const posted = await sql.begin(tx => postLedgerTransaction(tx, {
    organizationId: org, currency: "USD", kind: "adjustment", idempotencyKey: key(), sourceType: "test",
    lines: [{ accountCode: "tenant_revenue", amountMinor: 10 }, { accountCode: "fees", amountMinor: -10 }]
  }));
  await assert.rejects(sql`UPDATE ledger_entries SET amount_minor = 11 WHERE transaction_id = ${posted.id}`, /ledger_append_only/);
  await assert.rejects(sql`DELETE FROM ledger_transactions WHERE id = ${posted.id}`, /ledger_append_only/);
  const reversal = await sql.begin(tx => reverseLedgerTransaction(tx, org, posted.id, { idempotencyKey: key() }));
  const again = await sql.begin(tx => reverseLedgerTransaction(tx, org, posted.id, { idempotencyKey: key() }));
  assert.equal(again.id, reversal.id);
  assert.equal(again.created, false);
  assert.equal(await balance(org, "tenant_revenue"), 0);
  await assert.rejects(sql.begin(tx => reverseLedgerTransaction(tx, org, reversal.id, { idempotencyKey: key() })), /invalid_state_reversal_of_reversal/);
});

test("cross-tenant access to orders, refunds and webhook events is denied", async () => {
  const provider = new FakePaymentProvider();
  const { org, orderId, buyer, paymentReference } = await paidOrder(provider, 500);
  const other = await createTenant("Other tenant");
  assert.equal(await getPaymentOrder(other, orderId), null);
  await assert.rejects(requestRefund({ organizationId: other, orderId, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider), /order_not_found/);
  const forged = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_failed", organizationId: other, orderId, failureCode: "x" } });
  assert.equal(forged.outcome, "order_not_found");
  await assert.rejects(getSqlClient().begin(tx => reverseLedgerTransaction(tx, other, randomUUID(), { idempotencyKey: key() })), /ledger_transaction_not_found/);
  assert.equal((await getPaymentOrder(org, orderId))?.status, "succeeded");
  assert.ok(paymentReference);
});

test("reconciliation reports provider/ledger mismatches", async () => {
  const provider = new FakePaymentProvider();
  const since = new Date(Date.now() - 60_000);
  const { org, orderId, buyer, paymentReference } = await paidOrder(provider, 1000);
  await requestRefund({ organizationId: org, orderId, amountMinor: 250, reason: "operator", actorAccountId: buyer, idempotencyKey: key() }, provider);
  const clean = await reconcilePayments(org, provider, { since, until: new Date(Date.now() + 60_000), actorAccountId: buyer });
  assert.equal(clean.checkedCount, 1);
  assert.deepEqual(clean.mismatches, []);
  // Provider shows an extra refund the ledger never saw.
  provider.charges.find(c => c.paymentReference === paymentReference)!.amountRefundedMinor += 100;
  const second = await paidOrder(provider, 400);
  provider.charges.splice(provider.charges.findIndex(c => c.paymentReference === second.paymentReference), 1);
  const dirty = await reconcilePayments(org, provider, { since, until: new Date(Date.now() + 60_000), actorAccountId: buyer });
  assert.deepEqual(dirty.mismatches.map(m => m.type), ["amount_mismatch"]);
  assert.equal(dirty.mismatches[0]?.providerNetMinor, 650);
  assert.equal(dirty.mismatches[0]?.ledgerNetMinor, 750);
  const otherTenant = await reconcilePayments(second.org, provider, { since, until: new Date(Date.now() + 60_000), actorAccountId: null });
  assert.deepEqual(otherTenant.mismatches.map(m => m.type), ["missing_at_provider"]);
});
