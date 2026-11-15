import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@live-competition-engine/domain";
import type { CreatedLiveStream, ProviderStreamEvent, StreamingProvider } from "./streaming.ts";

const MUX_API = "https://api.mux.com/video/v1";
/** Mux's global RTMPS ingest endpoint. */
export const MUX_INGEST_URL = "rtmps://global-live.mux.com:443/app";

type Fetch = typeof fetch;

interface MuxCredentials { tokenId: string; tokenSecret: string }

/**
 * Real Mux Video live-stream adapter over `fetch`. Credentials come from
 * MUX_TOKEN_ID / MUX_TOKEN_SECRET via `requireMux()`; construction fails closed
 * (provider_not_configured) when they are absent. Only covered by tests with a
 * stubbed fetch: it has NOT been exercised against the live Mux API here.
 */
export class MuxStreamingProvider implements StreamingProvider {
  readonly name = "mux" as const;
  private readonly credentials: MuxCredentials;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;

  constructor(options: { credentials: MuxCredentials; fetch?: Fetch; timeoutMs?: number }) {
    if (!options.credentials?.tokenId || !options.credentials.tokenSecret) throw new DomainError("provider_not_configured");
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const auth = Buffer.from(`${this.credentials.tokenId}:${this.credentials.tokenSecret}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${MUX_API}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new DomainError("provider_unavailable");
    }
    if (response.status === 404) throw new DomainError("provider_stream_not_found");
    if (response.status === 401 || response.status === 403) throw new DomainError("provider_rejected_credentials");
    if (!response.ok) throw new DomainError("provider_unavailable");
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      throw new DomainError("provider_invalid_response");
    }
  }

  async createLiveStream(input: { reference: string }): Promise<CreatedLiveStream> {
    const result = await this.call("POST", "/live-streams", {
      playback_policy: ["public"],
      new_asset_settings: { playback_policy: ["public"] },
      passthrough: input.reference,
      reconnect_window: 60
    });
    const data = result?.data as { id?: unknown; stream_key?: unknown; playback_ids?: Array<{ id?: unknown }> } | undefined;
    if (!data || typeof data.id !== "string" || typeof data.stream_key !== "string") {
      throw new DomainError("provider_invalid_response");
    }
    const playbackId = data.playback_ids?.find(entry => typeof entry?.id === "string")?.id as string | undefined;
    return { providerStreamId: data.id, ingestUrl: MUX_INGEST_URL, streamKey: data.stream_key, playbackId: playbackId ?? null };
  }

  async resetStreamKey(providerStreamId: string) {
    const result = await this.call("POST", `/live-streams/${encodeURIComponent(providerStreamId)}/reset-stream-key`);
    const key = (result?.data as { stream_key?: unknown } | undefined)?.stream_key;
    if (typeof key !== "string") throw new DomainError("provider_invalid_response");
    return { streamKey: key };
  }

  async completeLiveStream(providerStreamId: string) {
    await this.call("PUT", `/live-streams/${encodeURIComponent(providerStreamId)}/complete`);
  }

  async deleteLiveStream(providerStreamId: string) {
    await this.call("DELETE", `/live-streams/${encodeURIComponent(providerStreamId)}`);
  }
}

/**
 * Build the adapter from validated configuration (`requireMux()`), failing closed
 * with `provider_not_configured` when MUX_TOKEN_ID / MUX_TOKEN_SECRET / MUX_WEBHOOK_SECRET
 * are absent. The config module is loaded lazily because it is not loadable under
 * Node's strip-only TypeScript mode used by this package's node:test suite.
 */
export async function createMuxProviderFromEnv(options: { fetch?: Fetch } = {}): Promise<MuxStreamingProvider> {
  const config = await loadMuxConfig();
  return new MuxStreamingProvider({ credentials: config, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

/** Webhook secret from validated configuration; throws provider_not_configured when absent. */
export async function muxWebhookSecret(): Promise<string> {
  return (await loadMuxConfig()).webhookSecret;
}

async function loadMuxConfig() {
  const { requireMux } = await import("@live-competition-engine/config/providers");
  try {
    return requireMux();
  } catch {
    throw new DomainError("provider_not_configured");
  }
}

/**
 * Verify a `mux-signature: t=<unix seconds>,v1=<hex hmac>` header: HMAC-SHA256
 * over `${t}.${rawBody}` with the webhook secret, constant-time compared, and the
 * timestamp within `toleranceSeconds` of `now`. Returns false on any doubt.
 */
export function verifyMuxSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  now = new Date(),
  toleranceSeconds = 300
): boolean {
  if (!header || !secret || header.length > 1024) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  return signatures.some(signature => {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  });
}

export function signMuxPayload(rawBody: string, secret: string, timestampSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${v1}`;
}

/** Normalize a Mux webhook JSON body into a provider event, or null when unusable. */
export function parseMuxEvent(body: unknown): ProviderStreamEvent | null {
  if (!body || typeof body !== "object") return null;
  const event = body as {
    id?: unknown; type?: unknown; created_at?: unknown;
    object?: { type?: unknown; id?: unknown };
    data?: { id?: unknown; live_stream_id?: unknown };
  };
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 200) return null;
  if (typeof event.type !== "string" || !/^video\.[a-z_]+\.[a-z_]+$/.test(event.type) || event.type.length > 100) return null;
  const type = event.type.slice("video.".length);
  const isAsset = type.startsWith("asset.");
  const rawStreamId = isAsset ? event.data?.live_stream_id : (event.object?.id ?? event.data?.id);
  const providerStreamId = typeof rawStreamId === "string" && rawStreamId.length <= 200 ? rawStreamId : null;
  const assetId = isAsset && typeof event.data?.id === "string" && event.data.id.length <= 200 ? event.data.id : null;
  const created = typeof event.created_at === "string" ? new Date(event.created_at) : null;
  return {
    provider: "mux",
    eventId: event.id,
    type,
    providerStreamId,
    assetId,
    occurredAt: created && !Number.isNaN(created.getTime()) ? created : null
  };
}
