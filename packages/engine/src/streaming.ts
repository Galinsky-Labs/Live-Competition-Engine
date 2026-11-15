import { DomainError } from "./errors.ts";

/**
 * LC-22 streaming foundation. Providers sit behind one interface so products can use a licensed
 * service when credentials exist, an operator-supplied embed when they do not, or nothing at all.
 * Nothing here claims a stream is live without provider evidence: status changes come from the
 * producer (or a provider webhook in future) and are recorded with who/when.
 */
export type StreamStatus = "idle" | "live" | "ended" | "failed";

export interface StreamSetup {
  provider: string;
  externalId: string | null;
  embedUrl: string | null;
  playbackUrl: string | null;
  ingestUrl: string | null;
  /** Secret ingest key: returned once to the producer and never stored by the engine. */
  streamKey: string | null;
}

export interface StreamingProvider {
  readonly id: "disabled" | "external_embed" | "mux";
  /** Whether the provider has what it needs (credentials) to operate. */
  configured(): boolean;
  setup(input: { eventId: string; title: string; embedUrl?: string | null }): Promise<StreamSetup>;
}

export const defaultEmbedHosts = ["www.youtube.com", "www.youtube-nocookie.com", "player.twitch.tv", "player.vimeo.com", "iframe.mediadelivery.net", "customer-*.cloudflarestream.com"];

export function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some(pattern => pattern.startsWith("customer-*.")
    ? host.startsWith("customer-") && host.endsWith(pattern.slice("customer-*".length))
    : host === pattern);
}

/** Validates an operator-provided player URL: https only, allow-listed host, no credentials. */
export function validateEmbedUrl(raw: unknown, allowed: string[] = defaultEmbedHosts): string {
  if (typeof raw !== "string" || raw.length > 2000) throw new DomainError(400, "invalid_embed_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError(400, "invalid_embed_url");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new DomainError(400, "invalid_embed_url");
  if (!hostAllowed(url.hostname, allowed)) throw new DomainError(400, "embed_host_not_allowed");
  return url.toString();
}

export const disabledProvider: StreamingProvider = {
  id: "disabled",
  configured: () => true,
  async setup() {
    throw new DomainError(409, "streaming_disabled");
  }
};

export function externalEmbedProvider(allowedHosts: string[] = defaultEmbedHosts): StreamingProvider {
  return {
    id: "external_embed",
    configured: () => true,
    async setup(input) {
      const embedUrl = validateEmbedUrl(input.embedUrl, allowedHosts);
      return { provider: "external_embed", externalId: null, embedUrl, playbackUrl: null, ingestUrl: null, streamKey: null };
    }
  };
}

/** Mux live streams. Only usable with MUX_TOKEN_ID/MUX_TOKEN_SECRET; never exercised without keys. */
export function muxProvider(env: { MUX_TOKEN_ID?: string; MUX_TOKEN_SECRET?: string }, fetchImpl: typeof fetch = fetch): StreamingProvider {
  return {
    id: "mux",
    configured: () => Boolean(env.MUX_TOKEN_ID && env.MUX_TOKEN_SECRET),
    async setup() {
      if (!env.MUX_TOKEN_ID || !env.MUX_TOKEN_SECRET) throw new DomainError(503, "streaming_provider_not_configured");
      const response = await fetchImpl("https://api.mux.com/video/v1/live-streams", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`).toString("base64")}` },
        body: JSON.stringify({ playback_policy: ["public"], new_asset_settings: { playback_policy: ["public"] }, latency_mode: "low" })
      });
      if (!response.ok) throw new DomainError(502, "streaming_provider_error");
      const { data } = (await response.json()) as { data: { id: string; stream_key: string; playback_ids?: Array<{ id: string }> } };
      const playbackId = data.playback_ids?.[0]?.id ?? null;
      return {
        provider: "mux", externalId: data.id, streamKey: data.stream_key,
        ingestUrl: "rtmps://global-live.mux.com:443/app",
        playbackUrl: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : null,
        embedUrl: playbackId ? `https://player.mux.com/${playbackId}` : null
      };
    }
  };
}

/** STREAMING_PROVIDER = disabled (default) | external_embed | mux. Mux without keys degrades to disabled. */
export function selectStreamingProvider(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): StreamingProvider {
  const extraHosts = (env.STREAM_EMBED_ALLOWED_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  switch (env.STREAMING_PROVIDER) {
    case "external_embed": return externalEmbedProvider([...defaultEmbedHosts, ...extraHosts]);
    case "mux": {
      const mux = muxProvider(env, fetchImpl);
      return mux.configured() ? mux : disabledProvider;
    }
    default: return disabledProvider;
  }
}

const streamTransitions: Record<StreamStatus, StreamStatus[]> = {
  idle: ["live", "failed"],
  live: ["ended", "failed"],
  failed: ["idle", "live", "ended"],
  ended: ["idle"]
};
export function assertStreamTransition(from: StreamStatus, to: StreamStatus) {
  if (!streamTransitions[from].includes(to)) throw new DomainError(409, "invalid_stream_transition");
}
