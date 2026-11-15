import { describe, expect, it, vi } from "vitest";
import { muxWebhookSecret, parseMuxEvent, signMuxPayload, verifyMuxSignature } from "@live-competition-engine/db/providers/mux";
import { createMuxWebhookHandler } from "./handler";

const secret = "mux-webhook-secret";
const body = JSON.stringify({ id: "evt-1", type: "video.live_stream.active", object: { type: "live", id: "ls-1" }, data: { id: "ls-1" } });
const post = (raw: string, signature: string | null) => new Request("https://engine.test/api/webhooks/mux", {
  method: "POST",
  headers: signature ? { "mux-signature": signature } : {},
  body: raw
});

function handler(apply = vi.fn(async () => "applied")) {
  return {
    apply,
    handle: createMuxWebhookHandler({
      webhookSecret: async () => secret,
      verify: verifyMuxSignature,
      parse: parseMuxEvent,
      apply
    })
  };
}

describe("Mux webhook", () => {
  it("applies a correctly signed event", async () => {
    const { handle, apply } = handler();
    const response = await handle(post(body, signMuxPayload(body, secret, Math.floor(Date.now() / 1000))));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "applied" });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-1", type: "live_stream.active", providerStreamId: "ls-1" }));
  });

  it("rejects missing, forged and stale signatures without applying", async () => {
    const { handle, apply } = handler();
    expect((await handle(post(body, null))).status).toBe(401);
    expect((await handle(post(body, signMuxPayload(body, "wrong", Math.floor(Date.now() / 1000))))).status).toBe(401);
    expect((await handle(post(body, signMuxPayload(body, secret, Math.floor(Date.now() / 1000) - 3600)))).status).toBe(401);
    const tampered = body.replace("active", "idle");
    expect((await handle(post(tampered, signMuxPayload(body, secret, Math.floor(Date.now() / 1000))))).status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("acknowledges authentic but unsupported or duplicate events", async () => {
    const { handle } = handler(vi.fn(async () => "duplicate"));
    const odd = JSON.stringify({ id: "x", type: "something.else" });
    expect(await (await handle(post(odd, signMuxPayload(odd, secret, Math.floor(Date.now() / 1000))))).json()).toEqual({ outcome: "unsupported" });
    expect(await (await handle(post(body, signMuxPayload(body, secret, Math.floor(Date.now() / 1000))))).json()).toEqual({ outcome: "duplicate" });
  });

  it("fails closed when the webhook secret is not configured", async () => {
    const saved = { ...process.env };
    delete process.env.MUX_TOKEN_ID;
    delete process.env.MUX_TOKEN_SECRET;
    delete process.env.MUX_WEBHOOK_SECRET;
    try {
      await expect(muxWebhookSecret()).rejects.toMatchObject({ code: "provider_not_configured" });
      const apply = vi.fn();
      const handle = createMuxWebhookHandler({ webhookSecret: muxWebhookSecret, verify: verifyMuxSignature, parse: parseMuxEvent, apply });
      expect((await handle(post(body, "t=1,v1=00"))).status).toBe(503);
      expect(apply).not.toHaveBeenCalled();
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
