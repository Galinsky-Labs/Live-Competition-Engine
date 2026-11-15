import { ingestPaymentEvent } from "@live-competition-engine/db/payments";
import { fulfillmentHooks } from "@live-competition-engine/db/payment-fulfillment";
import { stripeWebhookSecret } from "@live-competition-engine/db/payment-runtime";
import { normalizeStripeEvent, verifyStripeSignature } from "@live-competition-engine/db/providers/stripe";
import { createStripeWebhookHandler } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handler = createStripeWebhookHandler({
  webhookSecret: stripeWebhookSecret,
  verify: (rawBody, header, secret) => verifyStripeSignature(rawBody, header, secret),
  normalize: normalizeStripeEvent,
  ingest: input => ingestPaymentEvent("stripe", input, fulfillmentHooks())
});

export async function POST(request: Request) {
  return handler(request);
}
