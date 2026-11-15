import test from "node:test";
import assert from "node:assert/strict";
import { assertStreamTransition, muxProvider, selectStreamingProvider, validateEmbedUrl } from "./streaming.ts";

test("no-key default is disabled; embeds are https and allow-listed", async () => {
  const disabled = selectStreamingProvider({});
  assert.equal(disabled.id, "disabled");
  await assert.rejects(disabled.setup({ eventId: "e", title: "t" }), /streaming_disabled/);
  assert.equal(selectStreamingProvider({ STREAMING_PROVIDER: "mux" }).id, "disabled", "mux without keys degrades");
  const embed = selectStreamingProvider({ STREAMING_PROVIDER: "external_embed", STREAM_EMBED_ALLOWED_HOSTS: "video.example.org" });
  assert.equal((await embed.setup({ eventId: "e", title: "t", embedUrl: "https://www.youtube.com/embed/abc" })).embedUrl, "https://www.youtube.com/embed/abc");
  assert.ok(await embed.setup({ eventId: "e", title: "t", embedUrl: "https://video.example.org/live" }));
  await assert.rejects(embed.setup({ eventId: "e", title: "t", embedUrl: "http://www.youtube.com/embed/abc" }), /invalid_embed_url/);
  await assert.rejects(embed.setup({ eventId: "e", title: "t", embedUrl: "https://evil.example/x" }), /embed_host_not_allowed/);
  await assert.rejects(embed.setup({ eventId: "e", title: "t", embedUrl: "https://u:p@www.youtube.com/x" }), /invalid_embed_url/);
  assert.equal(validateEmbedUrl("https://customer-abc.cloudflarestream.com/x/iframe"), "https://customer-abc.cloudflarestream.com/x/iframe");
});

test("mux adapter maps provider responses and surfaces failures without a live claim", async () => {
  const ok = muxProvider({ MUX_TOKEN_ID: "id", MUX_TOKEN_SECRET: "secret" }, async () => new Response(JSON.stringify({ data: { id: "ls1", stream_key: "sk", playback_ids: [{ id: "pb1" }] } }), { status: 201 }));
  const setup = await ok.setup({ eventId: "e", title: "t" });
  assert.deepEqual([setup.externalId, setup.streamKey, setup.embedUrl], ["ls1", "sk", "https://player.mux.com/pb1"]);
  const failing = muxProvider({ MUX_TOKEN_ID: "id", MUX_TOKEN_SECRET: "secret" }, async () => new Response("no", { status: 500 }));
  await assert.rejects(failing.setup({ eventId: "e", title: "t" }), /streaming_provider_error/);
});

test("stream lifecycle includes failure and recovery", () => {
  assertStreamTransition("idle", "live");
  assertStreamTransition("live", "failed");
  assertStreamTransition("failed", "live");
  assert.throws(() => assertStreamTransition("ended", "live"), /invalid_stream_transition/);
});
