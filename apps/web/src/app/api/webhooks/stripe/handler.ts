import type { PaymentEvent } from "@live-competition-engine/db/providers/payments";
import { errorResponse, json } from "../../../../lib/http";

const MAX_WEBHOOK_BYTES = 512 * 1024;

export interface StripeWebhookDeps {
  webhookSecret(): string;
  verify(rawBody: string, header: string | null, secret: string): boolean;
  normalize(event: Record<string, unknown>): PaymentEvent | null;
  ingest(input: { eventId: string; eventType: string; rawBody: string; event: PaymentEvent | null }): Promise<{ duplicate: boolean; outcome: string }>;
}

/**
 * Stripe webhook: verify the signature over the exact raw body before parsing,
 * then store the event id and apply it atomically (replays are acknowledged
 * without effect). Processing errors propagate (500) so Stripe retries.
 */
export function createStripeWebhookHandler(deps: StripeWebhookDeps) {
  return async function postStripeWebhook(request: Request): Promise<Response> {
    let secret: string;
    try {
      secret = deps.webhookSecret();
    } catch {
      return errorResponse(503, "provider_not_configured");
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_WEBHOOK_BYTES) return errorResponse(413, "payload_too_large");
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) return errorResponse(413, "payload_too_large");
    if (!deps.verify(rawBody, request.headers.get("stripe-signature"), secret)) return errorResponse(400, "invalid_signature");
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return errorResponse(400, "invalid_body");
      event = parsed as Record<string, unknown>;
    } catch {
      return errorResponse(400, "invalid_json");
    }
    const eventId = event.id;
    const eventType = event.type;
    if (typeof eventId !== "string" || !/^evt_[A-Za-z0-9_]{1,250}$/.test(eventId) || typeof eventType !== "string") {
      return errorResponse(400, "invalid_event");
    }
    const result = await deps.ingest({ eventId, eventType, rawBody, event: deps.normalize(event) });
    return json({ received: true, duplicate: result.duplicate, outcome: result.outcome });
  };
}
