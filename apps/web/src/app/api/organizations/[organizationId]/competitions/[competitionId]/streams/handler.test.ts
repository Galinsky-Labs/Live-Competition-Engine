import { describe, expect, it, vi } from "vitest";
import type { StreamView } from "@live-competition-engine/db/streams";
import { ACCOUNT, COMP, ORG, domainError, fakeAuthorizer, jsonRequest } from "../../../../../../../lib/live-test-helpers";
import { createStreamHandlers, type StreamServices } from "./handler";

const STREAM = "44444444-4444-4444-8444-444444444444";
const stream: StreamView = {
  id: STREAM, competitionId: COMP, provider: "fake", providerStreamId: "ls", ingestUrl: "rtmps://x", streamKeyLast4: "abcd",
  playbackId: "pb", recordingAssetId: null, status: "idle", failureReason: null, published: false, previousStreamId: null,
  revision: 1, createdAt: "", updatedAt: ""
};

function services(overrides: Partial<StreamServices> = {}): StreamServices {
  return {
    provider: vi.fn(async () => ({ name: "fake" }) as never),
    createStream: vi.fn(async () => ({ stream, streamKey: "secret-key", replayed: false })),
    listStreams: vi.fn(async () => [stream]),
    getStream: vi.fn(async () => stream),
    recreateStream: vi.fn(async () => ({ stream, streamKey: "k2", replayed: false })),
    resetStreamKey: vi.fn(async () => ({ stream, streamKey: "k3", replayed: false })),
    endStream: vi.fn(async () => ({ ...stream, status: "ended" as const })),
    setStreamPublished: vi.fn(async () => ({ ...stream, published: true })),
    ...overrides
  };
}

const producer = fakeAuthorizer(ACCOUNT, ["event.manage"]);

describe("stream handlers", () => {
  it("creates a stream for a producer and returns the key once", async () => {
    const svc = services();
    const response = await createStreamHandlers(producer, svc).create(jsonRequest("POST", { idempotencyKey: "idem-12345" }), ORG, COMP);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.streamKey).toBe("secret-key");
    expect(svc.createStream).toHaveBeenCalledWith(ORG, COMP, ACCOUNT, { idempotencyKey: "idem-12345" }, expect.anything());
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not return a key on an idempotent replay", async () => {
    const svc = services({ createStream: vi.fn(async () => ({ stream, streamKey: null, replayed: true })) });
    const response = await createStreamHandlers(producer, svc).create(jsonRequest("POST", { idempotencyKey: "idem-12345" }), ORG, COMP);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("streamKey");
  });

  it("forbids performers and judges and never calls the service", async () => {
    const svc = services();
    const response = await createStreamHandlers(fakeAuthorizer(ACCOUNT, ["performance.submit", "judging.score"]), svc)
      .create(jsonRequest("POST", { idempotencyKey: "idem-12345" }), ORG, COMP);
    expect(response.status).toBe(403);
    expect(svc.createStream).not.toHaveBeenCalled();
    expect(svc.provider).not.toHaveBeenCalled();
  });

  it("rejects invalid input and unknown actions", async () => {
    const handlers = createStreamHandlers(producer, services());
    expect((await handlers.create(jsonRequest("POST", { idempotencyKey: 5 }), ORG, COMP)).status).toBe(400);
    expect((await handlers.act(jsonRequest("POST", { action: "explode" }), ORG, COMP, STREAM)).status).toBe(400);
    expect((await handlers.act(jsonRequest("POST", { action: "publish" }), ORG, COMP, STREAM)).status).toBe(400);
    expect((await handlers.create(jsonRequest("POST", { idempotencyKey: "idem-12345" }), "not-a-uuid", COMP)).status).toBe(404);
  });

  it("returns 404 for a stream of another competition or tenant", async () => {
    const otherCompetition = services({ getStream: vi.fn(async () => ({ ...stream, competitionId: ORG })) });
    expect((await createStreamHandlers(producer, otherCompetition).get(jsonRequest("GET"), ORG, COMP, STREAM)).status).toBe(404);
    const missing = services({ getStream: vi.fn(async () => { throw domainError("stream_not_found"); }) });
    expect((await createStreamHandlers(producer, missing).act(jsonRequest("POST", { action: "end" }), ORG, COMP, STREAM)).status).toBe(404);
  });

  it("maps provider and state failures", async () => {
    const unconfigured = services({ provider: vi.fn(async () => { throw domainError("provider_not_configured"); }) });
    expect((await createStreamHandlers(producer, unconfigured).create(jsonRequest("POST", { idempotencyKey: "idem-12345" }), ORG, COMP)).status).toBe(503);
    const disabled = services({ createStream: vi.fn(async () => { throw domainError("feature_disabled"); }) });
    expect((await createStreamHandlers(producer, disabled).create(jsonRequest("POST", { idempotencyKey: "idem-12345" }), ORG, COMP)).status).toBe(403);
    const terminal = services({ endStream: vi.fn(async () => { throw domainError("invalid_state_stream_ended_end"); }) });
    expect((await createStreamHandlers(producer, terminal).act(jsonRequest("POST", { action: "end" }), ORG, COMP, STREAM)).status).toBe(409);
  });

  it("runs recovery actions", async () => {
    const svc = services();
    const handlers = createStreamHandlers(producer, svc);
    const recreate = await handlers.act(jsonRequest("POST", { action: "recreate", idempotencyKey: "idem-99999" }), ORG, COMP, STREAM);
    expect(recreate.status).toBe(201);
    expect((await recreate.json()).streamKey).toBe("k2");
    expect((await (await handlers.act(jsonRequest("POST", { action: "reset_key" }), ORG, COMP, STREAM)).json()).streamKey).toBe("k3");
    const publish = await handlers.act(jsonRequest("POST", { action: "publish", expectedRevision: 1 }), ORG, COMP, STREAM);
    expect(publish.status).toBe(200);
    expect(svc.setStreamPublished).toHaveBeenCalledWith(ORG, STREAM, ACCOUNT, { published: true, expectedRevision: 1 });
  });
});
