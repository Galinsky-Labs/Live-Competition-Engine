import { secretsEqual } from "@live-competition-engine/db/providers/email";
import type { ProviderEvent } from "@live-competition-engine/db/notifications";
import { errorResponse, json, readJsonObject } from "../../../../lib/http";

export type ParseEvent = (body: Record<string, unknown>) => ProviderEvent | null;
export type ApplyEvent = (event: ProviderEvent) => Promise<{ action: string }>;

/**
 * Postmark bounce/complaint/delivery webhook. Postmark cannot sign webhooks with an HMAC,
 * so the endpoint is protected by a shared secret (POSTMARK_WEBHOOK_SECRET, >= 32 chars)
 * supplied either as HTTP Basic auth password (preferred: configure the webhook URL as
 * `https://postmark:<secret>@host/api/webhooks/postmark`) or as `?token=<secret>`.
 * Missing configuration fails closed with 503.
 */
export function createPostmarkWebhookHandler(secret: () => string | undefined, parse: ParseEvent, apply: ApplyEvent) {
  return async function post(request: Request): Promise<Response> {
    const expected = secret();
    if (!expected) return errorResponse(503, "webhook_not_configured");
    if (!authorized(request, expected)) return errorResponse(401, "invalid");
    const body = await readJsonObject(request, 64 * 1024);
    if (body instanceof Response) return body;
    const event = parse(body);
    if (!event) return errorResponse(400, "invalid_event");
    const result = await apply(event);
    return json({ received: true, action: result.action });
  };
}

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const basic = /^Basic ([A-Za-z0-9+/=]{1,1024})$/.exec(header);
  if (basic) {
    const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator >= 0 && secretsEqual(decoded.slice(separator + 1), expected)) return true;
  }
  const token = new URL(request.url).searchParams.get("token");
  return token !== null && token.length <= 512 && secretsEqual(token, expected);
}
