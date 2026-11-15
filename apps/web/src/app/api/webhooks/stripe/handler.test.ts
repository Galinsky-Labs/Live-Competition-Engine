import { describe, expect, it, vi } from "vitest";
import { normalizeStripeEvent, signStripePayload, verifyStripeSignature } from "@live-competition-engine/db/providers/stripe";
import { createStripeWebhookHandler } from "./handler";

const secret = "whsec_unit";
const org = "11111111-1111-4111-8111-111111111111";
const order = "22222222-2222-4222-8222-222222222222";

const event = {
  id: "evt_123", type: "checkout.session.completed",
  data: { object: { mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 500, currency: "usd", metadata: { order_id: order, organization_id: org } } }
};

const deliver = (body: string, signature: string | null) => new Request("https://engine.test/api/webhooks/stripe", {
  method: "POST", body, headers: signature ? { "stripe-signature": signature } : {}
});

describe("stripe webhook handler", () => {
  const seen = new Set<string>();
  const ingest = vi.fn(async (input: { eventId: string }) => {
    const duplicate = seen.has(input.eventId);
    seen.add(input.eventId);
    return { duplicate, outcome: duplicate ? "duplicate" : "succeeded" };
  });
  const handler = createStripeWebhookHandler({ webhookSecret: () => secret, verify: verifyStripeSignature, normalize: normalizeStripeEvent, ingest });

  it("rejects missing or forged signatures before parsing", async () => {
    const body = JSON.stringify(event);
    expect((await handler(deliver(body, null))).status).toBe(400);
    expect((await handler(deliver(body, signStripePayload(body, "whsec_other", Math.floor(Date.now() / 1000))))).status).toBe(400);
    expect((await handler(deliver(body, signStripePayload(body, secret, Math.floor(Date.now() / 1000) - 600)))).status).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("ingests a verified event once and acknowledges replays", async () => {
    const body = JSON.stringify(event);
    const signature = signStripePayload(body, secret, Math.floor(Date.now() / 1000));
    const first = await handler(deliver(body, signature));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ duplicate: false, outcome: "succeeded" });
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt_123", event: expect.objectContaining({ kind: "payment_succeeded", amountMinor: 500 }) }));
    const replay = await handler(deliver(body, signature));
    expect(await replay.json()).toMatchObject({ duplicate: true });
  });

  it("fails closed when the webhook secret is not configured and rejects malformed events", async () => {
    const unconfigured = createStripeWebhookHandler({ webhookSecret: () => { throw new Error("stripe is not configured"); }, verify: verifyStripeSignature, normalize: normalizeStripeEvent, ingest });
    expect((await unconfigured(deliver("{}", "t=1,v1=00"))).status).toBe(503);
    const body = JSON.stringify({ id: "nope", type: "x" });
    expect((await handler(deliver(body, signStripePayload(body, secret, Math.floor(Date.now() / 1000))))).status).toBe(400);
  });
});
