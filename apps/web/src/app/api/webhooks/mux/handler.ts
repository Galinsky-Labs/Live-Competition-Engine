import type { ProviderStreamEvent } from "@live-competition-engine/db/providers/streaming";

export interface MuxWebhookDeps {
  webhookSecret(): Promise<string>;
  verify(rawBody: string, header: string | null, secret: string): boolean;
  parse(body: unknown): ProviderStreamEvent | null;
  apply(event: ProviderStreamEvent): Promise<string>;
}

const MAX_WEBHOOK_BYTES = 64 * 1024;
const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/webhooks/mux. Verifies the HMAC signature over the raw body BEFORE
 * parsing, then applies the event idempotently (duplicate deliveries return 200).
 */
export function createMuxWebhookHandler(deps: MuxWebhookDeps) {
  return async function postMuxWebhook(request: Request): Promise<Response> {
    let secret: string;
    try {
      secret = await deps.webhookSecret();
    } catch {
      return reply(503, { error: "provider_not_configured" });
    }
    if (Number(request.headers.get("content-length") ?? "0") > MAX_WEBHOOK_BYTES) return reply(413, { error: "payload_too_large" });
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) return reply(413, { error: "payload_too_large" });
    if (!deps.verify(raw, request.headers.get("mux-signature"), secret)) return reply(401, { error: "invalid_signature" });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: "invalid_json" });
    }
    const event = deps.parse(body);
    // Unsupported but authentic events are acknowledged so the provider stops retrying.
    if (!event) return reply(200, { outcome: "unsupported" });
    const outcome = await deps.apply(event);
    return reply(200, { outcome });
  };
}
