import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import { FakeStreamingProvider, hashStreamKey } from "./providers/streaming.ts";
import {
  applyProviderStreamEvent,
  createStream,
  endStream,
  getPublicStreamEmbed,
  getStream,
  listStreams,
  recreateStream,
  resetStreamKey,
  setStreamPublished
} from "./streams.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

async function setup(feature = true) {
  const organizationId = await createTenant("Streams");
  const actor = await createAccount(organizationId);
  const competitionId = await createCompetition(organizationId, "Streamed event");
  if (feature) await enableFeature("streaming", organizationId, actor);
  return { organizationId, actor, competitionId };
}

const key = () => `idem-${randomUUID()}`;
const event = (providerStreamId: string, type: string, extra: { assetId?: string } = {}) => ({
  provider: "fake" as const, eventId: randomUUID(), type, providerStreamId, assetId: extra.assetId ?? null, occurredAt: null
});

test("creates a stream once, never stores or replays the key, and audits", async () => {
  const { organizationId, actor, competitionId } = await setup();
  const provider = new FakeStreamingProvider(randomUUID());
  const idempotencyKey = key();
  const first = await createStream(organizationId, competitionId, actor, { idempotencyKey }, provider);
  assert.equal(first.replayed, false);
  assert.ok(first.streamKey);
  assert.equal(first.stream.status, "idle");
  assert.equal(first.stream.streamKeyLast4, first.streamKey!.slice(-4));
  const [stored] = await getSqlClient()`SELECT stream_key_hash FROM streams WHERE id = ${first.stream.id}`;
  assert.equal(stored!.stream_key_hash, hashStreamKey(first.streamKey!));
  assert.ok(!JSON.stringify(first.stream).includes(first.streamKey!));

  const again = await createStream(organizationId, competitionId, actor, { idempotencyKey }, provider);
  assert.equal(again.replayed, true);
  assert.equal(again.streamKey, null);
  assert.equal(again.stream.id, first.stream.id);
  assert.equal(provider.streams.size, 1);

  await assert.rejects(createStream(organizationId, competitionId, actor, { idempotencyKey: key() }, provider), /stream_conflict_open_stream_exists/);
  assert.equal((await listStreams(organizationId, competitionId)).length, 1);
  assert.equal((await verifyAuditChain(organizationId)).valid, true);
});

test("fails closed when the streaming feature is disabled or the provider fails", async () => {
  const off = await setup(false);
  // Explicit tenant veto, regardless of the platform default other tests may set.
  await getSqlClient()`
    INSERT INTO feature_flags (scope_key, feature, scope, organization_id, enabled, revision, updated_by_account_id)
    VALUES (${`tenant:${off.organizationId}`}, 'streaming', 'tenant', ${off.organizationId}, false, 1, ${off.actor})
  `;
  const provider = new FakeStreamingProvider(randomUUID());
  await assert.rejects(createStream(off.organizationId, off.competitionId, off.actor, { idempotencyKey: key() }, provider), /feature_disabled/);
  assert.equal(provider.streams.size, 0);

  const on = await setup();
  provider.failNextCreate = true;
  await assert.rejects(createStream(on.organizationId, on.competitionId, on.actor, { idempotencyKey: key() }, provider), /fake provider unavailable/);
  assert.equal((await listStreams(on.organizationId, on.competitionId)).length, 0);
  await assert.rejects(createStream(on.organizationId, on.competitionId, on.actor, { idempotencyKey: "short" }, provider), /invalid_idempotency_key/);
});

test("rejects cross-tenant access to streams and competitions", async () => {
  const a = await setup();
  const b = await setup();
  const provider = new FakeStreamingProvider(randomUUID());
  const created = await createStream(a.organizationId, a.competitionId, a.actor, { idempotencyKey: key() }, provider);
  await assert.rejects(getStream(b.organizationId, created.stream.id), /stream_not_found/);
  await assert.rejects(setStreamPublished(b.organizationId, created.stream.id, b.actor, { published: true, expectedRevision: 1 }), /stream_not_found/);
  await assert.rejects(createStream(b.organizationId, a.competitionId, b.actor, { idempotencyKey: key() }, provider), /competition_not_found/);
  assert.equal((await listStreams(b.organizationId, a.competitionId)).length, 0);
});

test("applies provider lifecycle events idempotently and recovers by re-creating", async () => {
  const { organizationId, actor, competitionId } = await setup();
  const provider = new FakeStreamingProvider(randomUUID());
  const { stream } = await createStream(organizationId, competitionId, actor, { idempotencyKey: key() }, provider);
  const active = event(stream.providerStreamId, "live_stream.active");
  assert.equal(await applyProviderStreamEvent(active), "applied");
  assert.equal(await applyProviderStreamEvent(active), "duplicate");
  assert.equal((await getStream(organizationId, stream.id)).status, "active");
  assert.equal(await applyProviderStreamEvent(event(stream.providerStreamId, "live_stream.disconnected")), "applied");
  // Reconnect after an encoder drop.
  assert.equal(await applyProviderStreamEvent(event(stream.providerStreamId, "live_stream.active")), "applied");
  assert.equal(await applyProviderStreamEvent(event(stream.providerStreamId, "live_stream.errored")), "applied");
  const failed = await getStream(organizationId, stream.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureReason, "provider_error");
  assert.equal(await applyProviderStreamEvent(event(stream.providerStreamId, "live_stream.active")), "ignored:illegal_failed_to_active");
  assert.equal(await applyProviderStreamEvent(event("nope", "live_stream.active")), "unknown_stream");

  await assert.rejects(resetStreamKey(organizationId, stream.id, actor, provider), /invalid_state_stream_failed_reset_key/);
  const recovered = await recreateStream(organizationId, stream.id, actor, { idempotencyKey: key() }, provider);
  assert.ok(recovered.streamKey);
  assert.equal(recovered.stream.previousStreamId, stream.id);
  assert.equal(recovered.stream.status, "idle");

  const rotated = await resetStreamKey(organizationId, recovered.stream.id, actor, provider);
  assert.notEqual(rotated.streamKey, recovered.streamKey);
  assert.equal(rotated.stream.revision, recovered.stream.revision + 1);

  const ended = await endStream(organizationId, recovered.stream.id, actor, provider);
  assert.equal(ended.status, "ended");
  assert.equal(provider.streams.get(recovered.stream.providerStreamId)?.completed, true);
  assert.equal(await applyProviderStreamEvent(event(recovered.stream.providerStreamId, "asset.ready", { assetId: "asset-1" })), "recording");
  assert.equal((await getStream(organizationId, recovered.stream.id)).recordingAssetId, "asset-1");
  const actions = await getSqlClient()<{ action: string }[]>`
    SELECT action FROM audit_events WHERE organization_id = ${organizationId} ORDER BY sequence`;
  assert.deepEqual(actions.map(row => row.action), [
    "stream.created", "stream.active", "stream.disconnected", "stream.active", "stream.failed",
    "stream.recreated", "stream.key_reset", "stream.ended", "stream.recording_available"
  ]);
});

test("recreating a disconnected stream marks it replaced; concurrent creates allow one open stream", async () => {
  const { organizationId, actor, competitionId } = await setup();
  const provider = new FakeStreamingProvider(randomUUID());
  const { stream } = await createStream(organizationId, competitionId, actor, { idempotencyKey: key() }, provider);
  await applyProviderStreamEvent(event(stream.providerStreamId, "live_stream.active"));
  await applyProviderStreamEvent(event(stream.providerStreamId, "live_stream.disconnected"));
  const replacement = await recreateStream(organizationId, stream.id, actor, { idempotencyKey: key() }, provider);
  const old = await getStream(organizationId, stream.id);
  assert.equal(old.status, "failed");
  assert.equal(old.failureReason, "replaced_by_recreate");
  await endStream(organizationId, replacement.stream.id, actor, provider);

  const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
    createStream(organizationId, competitionId, actor, { idempotencyKey: key() }, provider)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const open = (await listStreams(organizationId, competitionId)).filter(s => s.status === "idle");
  assert.equal(open.length, 1);
  // Provider streams created by losing requests were cleaned up.
  const live = [...provider.streams.values()].filter(s => !s.deleted && !s.completed);
  assert.equal(live.length, 1);
});

test("public embed shows only a published stream of a public competition", async () => {
  const { organizationId, actor, competitionId } = await setup();
  const provider = new FakeStreamingProvider(randomUUID());
  const { stream } = await createStream(organizationId, competitionId, actor, { idempotencyKey: key() }, provider);
  await setStreamPublished(organizationId, stream.id, actor, { published: true, expectedRevision: 1 });
  assert.equal(await getPublicStreamEmbed(organizationId, competitionId), null, "draft competition is private");
  await getSqlClient()`UPDATE competitions SET status = 'live' WHERE id = ${competitionId}`;
  const embed = await getPublicStreamEmbed(organizationId, competitionId);
  assert.deepEqual(embed, { status: "idle", playbackId: stream.playbackId, live: false });
  await assert.rejects(setStreamPublished(organizationId, stream.id, actor, { published: false, expectedRevision: 1 }), /stream_revision_conflict/);
  await setStreamPublished(organizationId, stream.id, actor, { published: false, expectedRevision: 2 });
  assert.equal(await getPublicStreamEmbed(organizationId, competitionId), null);
  const other = await createTenant("Other");
  assert.equal(await getPublicStreamEmbed(other, competitionId), null);
});
