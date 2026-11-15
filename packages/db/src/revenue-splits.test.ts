import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant } from "./test-fixtures.ts";
import { FakePaymentProvider } from "./providers/fake-payments.ts";
import { createPaymentOrder, ingestPaymentEvent, ledgerBalances, ledgerTrialBalance, requestRefund } from "./payments.ts";
import { fulfillmentHooks } from "./payment-fulfillment.ts";
import {
  adjustSplit,
  createSplitRule,
  getOrderAllocations,
  listSplitRules,
  partyAccountCode,
  payoutStatement,
  quoteSplit,
  resolveSplitRule
} from "./revenue-splits.ts";

after(async () => { await closeDatabaseConnection(); });

const key = () => `test-${randomUUID()}`;
const hooks = fulfillmentHooks();

async function setup() {
  const org = await createTenant("Split tenant");
  const operator = await createAccount(org);
  const buyer = await createAccount(org);
  const event = await createCompetition(org);
  return { org, operator, buyer, event };
}

async function pay(org: string, buyer: string, event: string | null, amount: number, extra: { payeeType?: "participant"; payeeId?: string; purpose?: "ticket" | "tip" } = {}) {
  const { order } = await getSqlClient().begin(tx => createPaymentOrder(tx, {
    organizationId: org, accountId: buyer, eventId: event, purpose: extra.purpose ?? "ticket", description: "Admission",
    amountMinor: amount, currency: "USD", provider: "fake", idempotencyKey: key(),
    ...(extra.payeeId ? { payeeType: extra.payeeType ?? "participant", payeeId: extra.payeeId } : {})
  }));
  const paymentReference = `pi_${randomUUID()}`;
  const result = await ingestPaymentEvent("fake", { eventId: `evt_${randomUUID()}`, eventType: "x", rawBody: "{}",
    event: { kind: "payment_succeeded", organizationId: org, orderId: order.id, paymentReference, amountMinor: amount, currency: "USD" } }, hooks);
  assert.equal(result.outcome, "succeeded");
  return order.id;
}

const balances = async (org: string) => Object.fromEntries((await ledgerBalances(org)).map(b => [b.code, b.balanceMinor]));

test("split rules are versioned and resolved by event/purpose precedence", async () => {
  const { org, operator, event } = await setup();
  const performer = randomUUID();
  const v1 = await createSplitRule(org, { lines: [{ partyType: "platform", bps: 1000 }, { partyType: "tenant" }] }, operator);
  const v2 = await createSplitRule(org, { lines: [{ partyType: "platform", bps: 500 }, { partyType: "tenant" }] }, operator);
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  const eventRule = await createSplitRule(org, { eventId: event, lines: [{ partyType: "tenant" }, { partyType: "performer", partyId: performer, bps: 5000 }], remainderLine: 0 }, operator);
  const tipRule = await createSplitRule(org, { purpose: "tip", lines: [{ partyType: "platform", bps: 300 }, { partyType: "payee" }], remainderLine: 1 }, operator);
  const sql = getSqlClient();
  assert.equal((await resolveSplitRule(sql, org, null, "ticket"))?.id, v2.id);
  assert.equal((await resolveSplitRule(sql, org, event, "ticket"))?.id, eventRule.id);
  assert.equal((await resolveSplitRule(sql, org, null, "tip"))?.id, tipRule.id);
  assert.equal((await listSplitRules(org)).length, 4);
  await assert.rejects(sql`UPDATE revenue_split_rules SET remainder_line = 0 WHERE id = ${v1.id}`, /ledger_append_only/);
  await assert.rejects(createSplitRule(org, { lines: [{ partyType: "platform", bps: 20000 }] }, operator), /invalid_split_bps/);
  // Concurrent publishers get distinct versions.
  const raced = await Promise.all([1, 2, 3].map(() => createSplitRule(org, { lines: [{ partyType: "tenant" }] }, operator)));
  assert.deepEqual(raced.map(r => r.version).sort(), [3, 4, 5]);
  const other = await createTenant();
  await assert.rejects(createSplitRule(other, { eventId: event, lines: [{ partyType: "tenant" }] }, operator), /event_not_found/);
  const quote = await quoteSplit(sql, org, { eventId: null, purpose: "tip", grossMinor: 1000, payee: { type: "participant", id: performer } });
  assert.deepEqual(quote.allocations.map(a => [a.accountCode, a.amountMinor]), [["platform_revenue", 30], [`payable:participant:${performer}`, 970]]);
});

test("a settled payment posts split allocations that sum to the gross amount", async () => {
  const { org, operator, buyer, event } = await setup();
  const performer = randomUUID();
  const rights = randomUUID();
  await createSplitRule(org, { eventId: event, lines: [
    { partyType: "platform", bps: 500, fixedMinor: 30 },
    { partyType: "tenant", bps: 2000 },
    { partyType: "performer", partyId: performer, bps: 6000 },
    { partyType: "rights_owner", partyId: rights, bps: 1000 }
  ], remainderLine: 1 }, operator);
  const orderId = await pay(org, buyer, event, 1000);
  const b = await balances(org);
  assert.equal(b.platform_revenue, -78);
  assert.equal(b.tenant_revenue, -243);
  assert.equal(b[`payable:performer:${performer}`], -582);
  assert.equal(b[`payable:rights_owner:${rights}`], -97);
  assert.equal(b.sales_clearing, 0);
  assert.equal(b.provider_clearing, 1000);
  assert.deepEqual(await ledgerTrialBalance(org), { USD: 0 });
  assert.equal((await getOrderAllocations(org, orderId))?.reduce((s, a) => s + a.amountMinor, 0), 1000);

  // Partial then full refund come back out of each party proportionally.
  const provider = new FakePaymentProvider();
  await requestRefund({ organizationId: org, orderId, amountMinor: 333, reason: "operator", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  const mid = await balances(org);
  assert.equal(mid.provider_clearing, 667);
  assert.equal(Object.values(mid).reduce((s, v) => s + v, 0), 0);
  await requestRefund({ organizationId: org, orderId, reason: "operator", actorAccountId: operator, idempotencyKey: key() }, provider, hooks);
  const end = await balances(org);
  for (const value of Object.values(end)) assert.equal(value, 0);
});

test("adjustments reverse and repost; refunded orders cannot be adjusted", async () => {
  const { org, operator, buyer } = await setup();
  const promoter = randomUUID();
  const orderId = await pay(org, buyer, null, 2000);
  assert.equal((await balances(org)).tenant_revenue, -2000);
  const rule = await createSplitRule(org, { lines: [{ partyType: "tenant" }, { partyType: "promoter", partyId: promoter, bps: 2500 }] }, operator);
  const adjusted = await adjustSplit(org, orderId, rule.id, operator);
  assert.deepEqual(adjusted.allocations.map(a => a.amountMinor), [1500, 500]);
  const b = await balances(org);
  assert.equal(b.tenant_revenue, -1500);
  assert.equal(b[`payable:promoter:${promoter}`], -500);
  const reversals = await getSqlClient()`SELECT 1 FROM ledger_transactions WHERE organization_id = ${org} AND kind = 'reversal'`;
  assert.equal(reversals.length, 1);
  const statement = await payoutStatement(org, { accountCode: partyAccountCode("promoter", promoter), currency: "usd", from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) });
  assert.equal(statement.owedMinor, 500);
  assert.equal(statement.lines.length, 1);

  await requestRefund({ organizationId: org, orderId, amountMinor: 100, reason: "operator", actorAccountId: operator, idempotencyKey: key() }, new FakePaymentProvider(), hooks);
  await assert.rejects(adjustSplit(org, orderId, rule.id, operator), /invalid_state_refunded/);
});

test("cross-tenant split adjustments and rules are denied", async () => {
  const a = await setup();
  const b = await setup();
  const orderId = await pay(a.org, a.buyer, null, 500);
  const foreignRule = await createSplitRule(b.org, { lines: [{ partyType: "tenant" }] }, b.operator);
  await assert.rejects(adjustSplit(b.org, orderId, foreignRule.id, b.operator), /order_not_found/);
  await assert.rejects(adjustSplit(a.org, orderId, foreignRule.id, a.operator), /split_rule_not_found/);
  const statement = await payoutStatement(b.org, { accountCode: "tenant_revenue", currency: "USD", from: new Date(0), to: new Date(Date.now() + 60_000) });
  assert.equal(statement.lines.length, 0);
});
