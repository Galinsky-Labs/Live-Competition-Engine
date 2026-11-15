/**
 * LC-22 streaming lifecycle. Pure: no I/O, no clock.
 *
 * idle -> active -> disconnected -> active (reconnect) | ended
 * any non-terminal -> failed; ended and failed are terminal for a stream row.
 * Recovery from a terminal state is a *re-create* (a new stream row linked to the old one).
 */
import { DomainError } from "./index.ts";

export const streamStatuses = ["idle", "active", "disconnected", "ended", "failed"] as const;
export type StreamStatus = (typeof streamStatuses)[number];

const transitions: Readonly<Record<StreamStatus, readonly StreamStatus[]>> = {
  idle: ["active", "ended", "failed"],
  active: ["disconnected", "ended", "failed"],
  disconnected: ["active", "ended", "failed"],
  ended: [],
  failed: []
};

export function isTerminalStreamStatus(status: StreamStatus): boolean {
  return transitions[status].length === 0;
}

export function canTransitionStream(from: StreamStatus, to: StreamStatus): boolean {
  return transitions[from].includes(to);
}

export function assertStreamTransition(from: StreamStatus, to: StreamStatus): void {
  if (!canTransitionStream(from, to)) throw new DomainError(`invalid_state_stream_${from}_to_${to}`);
}

/** Producer operations allowed per status. */
export function canResetStreamKey(status: StreamStatus): boolean {
  return status === "idle" || status === "disconnected";
}

export function canRecreateStream(status: StreamStatus): boolean {
  return status === "failed" || status === "ended" || status === "disconnected";
}

export type ProviderEventEffect =
  | { kind: "transition"; to: StreamStatus; reason?: string }
  | { kind: "recording"; assetId: string }
  | { kind: "ignore"; reason: string };

/**
 * Map a provider lifecycle event (normalized names, see the Mux adapter) to an
 * effect on a stream in `current` status. Out-of-order or replayed events that
 * would make an illegal transition are ignored rather than failing the webhook.
 */
export function streamEffectForEvent(
  current: StreamStatus,
  event: { type: string; assetId?: string | null }
): ProviderEventEffect {
  const to = ((): StreamStatus | "recording" | null => {
    switch (event.type) {
      case "live_stream.active": return "active";
      case "live_stream.disconnected": return "disconnected";
      // Mux emits idle when the reconnect window lapses after a session: the session is over.
      case "live_stream.idle": return current === "idle" ? null : "ended";
      case "live_stream.deleted": return current === "ended" ? null : "failed";
      case "live_stream.errored": return "failed";
      case "asset.live_stream_completed":
      case "asset.created":
      case "asset.ready": return "recording";
      default: return null;
    }
  })();
  if (to === null) return { kind: "ignore", reason: "no_effect" };
  if (to === "recording") {
    return event.assetId ? { kind: "recording", assetId: event.assetId } : { kind: "ignore", reason: "missing_asset" };
  }
  if (current === to) return { kind: "ignore", reason: "already_in_state" };
  if (!canTransitionStream(current, to)) return { kind: "ignore", reason: `illegal_${current}_to_${to}` };
  return {
    kind: "transition",
    to,
    ...(event.type === "live_stream.deleted" ? { reason: "provider_deleted" } : {}),
    ...(event.type === "live_stream.errored" ? { reason: "provider_error" } : {})
  };
}

/** Public embed projection: playback id only when published and not failed. */
export function publicEmbed(stream: { status: StreamStatus; published: boolean; playbackId: string | null }) {
  if (!stream.published || !stream.playbackId || stream.status === "failed") return null;
  return {
    status: stream.status,
    playbackId: stream.playbackId,
    live: stream.status === "active"
  };
}
