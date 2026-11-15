import test, { after } from "node:test";
import assert from "node:assert/strict";
import { closeDatabaseConnection } from "./index.ts";
import {
  formEncode,
  normalizeStripeEvent,
  signStripePayload,
  StripePaymentProvider,
  verifyStripeSignature
} from "./providers/stripe.ts";

after(async () => { await closeDatabaseConnection(); });

const secret = "whsec_test_secret";
const org = "11111111-1111-4111-8111-111111111111";
const order = "22222222-2222-4222-8222-222222222222";

test("verifies Stripe-Signature HMAC with a 5 minute tolerance", () => {
  const body = JSON.stringify({ id: "evt_1" });
  const now = 1_800_000_000;
  const header = signStripePayload(body, secret, now);
  assert.equal(verifyStripeSignature(body, header, secret, now), true);
  assert.equal(verifyStripeSignature(body, header, secret, now + 299), true);
  assert.equal(verifyStripeSignature(body, header, secret, now + 301), false);
  assert.equal(verifyStripeSignature(`${body} `, header, secret, now), false);
  assert.equal(verifyStripeSignature(body, header, "whsec_other", now), false);
  assert.equal(verifyStripeSignature(body, null, secret, now), false);
  assert.equal(verifyStripeSignature(body, `t=${now}`, secret, now), false);
  // Multiple v1 values (secret rotation) are accepted if any matches.
  const rotated = `${header},v1=${"0".repeat(64)}`;
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${"0".repeat(64)},${header.split(",")[1]}`, secret, now), true);
  assert.equal(verifyStripeSignature(body, rotated, secret, now), true);
});

test("normalizes the Stripe events the engine acts on", () => {
  assert.deepEqual(normalizeStripeEvent({
    type: "checkout.session.completed",
    data: { object: { mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 1500, currency: "usd", metadata: { order_id: order, organization_id: org } } }
  }), { kind: "payment_succeeded", organizationId: org, orderId: order, paymentReference: "pi_1", amountMinor: 1500, currency: "USD" });
  assert.equal(normalizeStripeEvent({
    type: "checkout.session.completed",
    data: { object: { mode: "payment", payment_status: "unpaid", payment_intent: "pi_1", amount_total: 1500, currency: "usd", metadata: { order_id: order, organization_id: org } } }
  }), null);
  assert.deepEqual(normalizeStripeEvent({ type: "checkout.session.expired", data: { object: { mode: "payment", metadata: { order_id: order, organization_id: org } } } }),
    { kind: "payment_cancelled", organizationId: org, orderId: order });
  const invoice = normalizeStripeEvent({
    type: "invoice.paid",
    data: { object: { id: "in_1", parent: { subscription_details: { subscription: "sub_1" } }, amount_paid: 500, currency: "eur", payment_intent: "pi_2",
      lines: { data: [{ period: { start: 1_800_000_000, end: 1_802_592_000 } }] } } }
  });
  assert.equal(invoice?.kind, "invoice_paid");
  assert.equal(normalizeStripeEvent({ type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: "pi_1", amount: 100, currency: "usd" } } })?.kind, "chargeback");
  assert.equal(normalizeStripeEvent({ type: "customer.created", data: { object: {} } }), null);
  // Metadata must carry well-formed identifiers.
  assert.equal(normalizeStripeEvent({ type: "checkout.session.expired", data: { object: { mode: "payment", metadata: { order_id: "x", organization_id: org } } } }), null);
});

test("Stripe adapter sends form-encoded, idempotent requests and fails closed", async () => {
  assert.equal(formEncode({ a: { b: [{ c: 1 }] }, d: undefined, e: true }), "a%5Bb%5D%5B0%5D%5Bc%5D=1&e=true");
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new StripePaymentProvider({
    secretKey: "sk_test_x",
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/refunds")) return Response.json({ id: "re_1", status: "pending" });
      if (url.includes("/charges")) return Response.json({ data: [{ id: "ch_1", status: "succeeded", payment_intent: "pi_1", amount_captured: 100, amount_refunded: 10, currency: "usd", created: 1 }], has_more: false });
      return Response.json({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
    }
  });
  const session = await provider.createCheckout({
    organizationId: org, orderId: order, amountMinor: 1500, currency: "USD", description: "Ticket",
    successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no", idempotencyKey: `checkout:${order}`
  });
  assert.equal(session.reference, "cs_1");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["idempotency-key"], `checkout:${order}`);
  assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(headers.authorization, "Bearer sk_test_x");
  const body = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(body.get("mode"), "payment");
  assert.equal(body.get("line_items[0][price_data][unit_amount]"), "1500");
  assert.equal(body.get("line_items[0][price_data][currency]"), "usd");
  assert.equal(body.get("metadata[order_id]"), order);
  assert.equal(body.get("payment_intent_data[metadata][organization_id]"), org);
  assert.deepEqual(await provider.refund({ organizationId: org, refundId: order, paymentReference: "pi_1", amountMinor: 10, idempotencyKey: "refund:1" }),
    { reference: "re_1", status: "pending" });
  const charges = await provider.listCharges({ since: new Date(0), until: new Date(10_000) });
  assert.equal(charges[0]?.amountRefundedMinor, 10);
  assert.ok(calls[2]!.url.includes("created%5Bgte%5D=0"));

  const failing = new StripePaymentProvider({ secretKey: "sk_test_x", fetcher: async () => Response.json({ error: { code: "x" } }, { status: 400 }) });
  await assert.rejects(failing.refund({ organizationId: org, refundId: order, paymentReference: "pi_1", amountMinor: 1, idempotencyKey: "k" }), /provider_rejected/);
  const down = new StripePaymentProvider({ secretKey: "sk_test_x", fetcher: async () => { throw new Error("network"); } });
  await assert.rejects(down.listCharges({ since: new Date(0), until: new Date(1000) }), /provider_unavailable/);
  const saved = { key: process.env.STRIPE_SECRET_KEY, hook: process.env.STRIPE_WEBHOOK_SECRET };
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.throws(() => new StripePaymentProvider(), /stripe is not configured/);
  if (saved.key) process.env.STRIPE_SECRET_KEY = saved.key;
  if (saved.hook) process.env.STRIPE_WEBHOOK_SECRET = saved.hook;
});
