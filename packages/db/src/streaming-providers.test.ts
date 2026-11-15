import test from "node:test";
import assert from "node:assert/strict";
import { MUX_INGEST_URL, MuxStreamingProvider, parseMuxEvent, signMuxPayload, verifyMuxSignature } from "./providers/mux.ts";
import { FakeStreamingProvider } from "./providers/streaming.ts";

const credentials = { tokenId: "token-id", tokenSecret: "token-secret" };

test("Mux adapter fails closed without credentials", () => {
  assert.throws(() => new MuxStreamingProvider({ credentials: { tokenId: "", tokenSecret: "" } }), /provider_not_configured/);
});

test("Mux adapter creates a live stream with basic auth and maps the response", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ data: { id: "ls-1", stream_key: "secret-key", status: "idle", playback_ids: [{ id: "pb-1", policy: "public" }] } }, { status: 201 });
  }) as typeof fetch;
  const provider = new MuxStreamingProvider({ credentials, fetch: fetchStub });
  const created = await provider.createLiveStream({ reference: "ref-1" });
  assert.deepEqual(created, { providerStreamId: "ls-1", ingestUrl: MUX_INGEST_URL, streamKey: "secret-key", playbackId: "pb-1" });
  assert.equal(calls[0]!.url, "https://api.mux.com/video/v1/live-streams");
  assert.equal(calls[0]!.init.method, "POST");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from("token-id:token-secret").toString("base64")}`);
  assert.equal(JSON.parse(String(calls[0]!.init.body)).passthrough, "ref-1");
});

test("Mux adapter maps failures to domain errors", async () => {
  const respond = (status: number, body = "{}") => new MuxStreamingProvider({
    credentials, fetch: (async () => new Response(body, { status })) as typeof fetch
  });
  await assert.rejects(respond(401).createLiveStream({ reference: "r" }), /provider_rejected_credentials/);
  await assert.rejects(respond(500).createLiveStream({ reference: "r" }), /provider_unavailable/);
  await assert.rejects(respond(404).resetStreamKey("ls"), /provider_stream_not_found/);
  await assert.rejects(respond(200, "{\"data\":{}}").createLiveStream({ reference: "r" }), /provider_invalid_response/);
  const offline = new MuxStreamingProvider({ credentials, fetch: (async () => { throw new TypeError("network"); }) as typeof fetch });
  await assert.rejects(offline.completeLiveStream("ls"), /provider_unavailable/);
  await respond(200, "").completeLiveStream("ls");
});

test("Mux signatures are verified with timestamp tolerance and constant-time comparison", () => {
  const body = JSON.stringify({ id: "evt", type: "video.live_stream.active" });
  const now = new Date("2026-11-15T12:00:00Z");
  const t = Math.floor(now.getTime() / 1000);
  const header = signMuxPayload(body, "whsec", t);
  assert.equal(verifyMuxSignature(body, header, "whsec", now), true);
  assert.equal(verifyMuxSignature(body + " ", header, "whsec", now), false, "tampered body");
  assert.equal(verifyMuxSignature(body, header, "other", now), false, "wrong secret");
  assert.equal(verifyMuxSignature(body, header, "whsec", new Date(now.getTime() + 301_000)), false, "stale");
  assert.equal(verifyMuxSignature(body, null, "whsec", now), false);
  assert.equal(verifyMuxSignature(body, `t=${t}`, "whsec", now), false);
  assert.equal(verifyMuxSignature(body, `t=${t},v1=zz`, "whsec", now), false);
  assert.equal(verifyMuxSignature(body, `t=${t},v1=${"0".repeat(64)},${header.split(",")[1]}`, "whsec", now), true, "any v1 may match");
});

test("Mux webhook bodies are normalized", () => {
  assert.deepEqual(parseMuxEvent({ id: "e1", type: "video.live_stream.active", object: { type: "live", id: "ls-1" }, data: { id: "ls-1" }, created_at: "2026-11-15T12:00:00Z" }), {
    provider: "mux", eventId: "e1", type: "live_stream.active", providerStreamId: "ls-1", assetId: null, occurredAt: new Date("2026-11-15T12:00:00Z")
  });
  const asset = parseMuxEvent({ id: "e2", type: "video.asset.ready", object: { type: "asset", id: "a-1" }, data: { id: "a-1", live_stream_id: "ls-1" } });
  assert.equal(asset?.providerStreamId, "ls-1");
  assert.equal(asset?.assetId, "a-1");
  assert.equal(parseMuxEvent({ id: "e3", type: "<script>" }), null);
  assert.equal(parseMuxEvent(null), null);
});

test("fake provider is deterministic per seed", async () => {
  const a = await new FakeStreamingProvider("seed").createLiveStream({ reference: "x" });
  const b = await new FakeStreamingProvider("seed").createLiveStream({ reference: "y" });
  assert.deepEqual(a, b);
});
