import { createHash } from "node:crypto";

/**
 * Streaming provider boundary (LC-22). Implementations: `MuxStreamingProvider`
 * (real HTTP adapter, ./mux.ts) and `FakeStreamingProvider` (deterministic, tests only).
 */
export interface CreatedLiveStream {
  providerStreamId: string;
  ingestUrl: string;
  /** Secret RTMP(S) stream key. Shown to the producer once; never persisted in plaintext. */
  streamKey: string;
  playbackId: string | null;
}

export interface StreamingProvider {
  readonly name: "mux" | "fake";
  /** `reference` is an opaque engine id (stream request id) sent as provider passthrough. */
  createLiveStream(input: { reference: string }): Promise<CreatedLiveStream>;
  resetStreamKey(providerStreamId: string): Promise<{ streamKey: string }>;
  /** Signal the provider that the live session is over (recording is finalized). */
  completeLiveStream(providerStreamId: string): Promise<void>;
  /** Best-effort cleanup of a provider stream the engine could not persist. */
  deleteLiveStream(providerStreamId: string): Promise<void>;
}

/** Normalized provider webhook event consumed by the stream service. */
export interface ProviderStreamEvent {
  provider: "mux" | "fake";
  eventId: string;
  /** Normalized type, e.g. "live_stream.active", "asset.ready". */
  type: string;
  providerStreamId: string | null;
  assetId: string | null;
  occurredAt: Date | null;
}

export function hashStreamKey(streamKey: string): string {
  return createHash("sha256").update(`stream-key\0${streamKey}`, "utf8").digest("hex");
}

/**
 * Deterministic in-memory provider for tests and local development. It never
 * contacts a network and proves nothing about real provider behavior.
 */
export class FakeStreamingProvider implements StreamingProvider {
  readonly name = "fake" as const;
  readonly streams = new Map<string, { reference: string; key: string; completed: boolean; deleted: boolean }>();
  failNextCreate = false;
  private counter = 0;
  private readonly seed: string;

  constructor(seed = "fake") {
    this.seed = seed;
  }

  private next(kind: string): string {
    this.counter += 1;
    return createHash("sha256").update(`${this.seed}:${kind}:${this.counter}`).digest("hex").slice(0, 24);
  }

  async createLiveStream(input: { reference: string }): Promise<CreatedLiveStream> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw Object.assign(new Error("fake provider unavailable"), { code: "provider_unavailable" });
    }
    const providerStreamId = `fake-ls-${this.next("stream")}`;
    const streamKey = `fake-sk-${this.next("key")}`;
    this.streams.set(providerStreamId, { reference: input.reference, key: streamKey, completed: false, deleted: false });
    return {
      providerStreamId,
      ingestUrl: "rtmps://ingest.fake.invalid:443/app",
      streamKey,
      playbackId: `fake-pb-${this.next("playback")}`
    };
  }

  async resetStreamKey(providerStreamId: string) {
    const stream = this.streams.get(providerStreamId);
    if (!stream || stream.deleted) throw Object.assign(new Error("unknown stream"), { code: "provider_stream_not_found" });
    stream.key = `fake-sk-${this.next("key")}`;
    return { streamKey: stream.key };
  }

  async completeLiveStream(providerStreamId: string) {
    const stream = this.streams.get(providerStreamId);
    if (stream) stream.completed = true;
  }

  async deleteLiveStream(providerStreamId: string) {
    const stream = this.streams.get(providerStreamId);
    if (stream) stream.deleted = true;
  }
}
