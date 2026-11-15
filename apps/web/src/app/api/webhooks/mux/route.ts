import { muxWebhookSecret, parseMuxEvent, verifyMuxSignature } from "@live-competition-engine/db/providers/mux";
import { applyProviderStreamEvent } from "@live-competition-engine/db/streams";
import { createMuxWebhookHandler } from "./handler";

export const dynamic = "force-dynamic";

const handler = createMuxWebhookHandler({
  webhookSecret: muxWebhookSecret,
  verify: (raw, header, secret) => verifyMuxSignature(raw, header, secret),
  parse: parseMuxEvent,
  apply: applyProviderStreamEvent
});

export async function POST(request: Request) {
  return handler(request);
}
