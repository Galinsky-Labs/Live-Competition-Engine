import { describe, expect, it } from "vitest";
import {
  assertStreamTransition,
  canRecreateStream,
  canResetStreamKey,
  canTransitionStream,
  isTerminalStreamStatus,
  publicEmbed,
  streamEffectForEvent,
  streamStatuses
} from "./streaming.ts";

describe("stream lifecycle", () => {
  it("allows only the documented transitions", () => {
    const allowed = streamStatuses.flatMap(from => streamStatuses.filter(to => canTransitionStream(from, to)).map(to => `${from}>${to}`));
    expect(allowed.sort()).toEqual([
      "active>disconnected", "active>ended", "active>failed",
      "disconnected>active", "disconnected>ended", "disconnected>failed",
      "idle>active", "idle>ended", "idle>failed"
    ]);
    expect(isTerminalStreamStatus("ended")).toBe(true);
    expect(isTerminalStreamStatus("failed")).toBe(true);
    expect(() => assertStreamTransition("ended", "active")).toThrow(/invalid_state_stream_ended_to_active/);
  });

  it("limits recovery operations by status", () => {
    expect(streamStatuses.filter(canResetStreamKey)).toEqual(["idle", "disconnected"]);
    expect(streamStatuses.filter(canRecreateStream)).toEqual(["disconnected", "ended", "failed"]);
  });

  it("maps provider events and ignores replays and out-of-order events", () => {
    expect(streamEffectForEvent("idle", { type: "live_stream.active" })).toEqual({ kind: "transition", to: "active" });
    expect(streamEffectForEvent("active", { type: "live_stream.active" })).toEqual({ kind: "ignore", reason: "already_in_state" });
    expect(streamEffectForEvent("active", { type: "live_stream.disconnected" })).toEqual({ kind: "transition", to: "disconnected" });
    expect(streamEffectForEvent("disconnected", { type: "live_stream.active" })).toEqual({ kind: "transition", to: "active" });
    expect(streamEffectForEvent("disconnected", { type: "live_stream.idle" })).toEqual({ kind: "transition", to: "ended" });
    expect(streamEffectForEvent("idle", { type: "live_stream.idle" }).kind).toBe("ignore");
    expect(streamEffectForEvent("ended", { type: "live_stream.active" })).toEqual({ kind: "ignore", reason: "illegal_ended_to_active" });
    expect(streamEffectForEvent("active", { type: "live_stream.deleted" })).toEqual({ kind: "transition", to: "failed", reason: "provider_deleted" });
    expect(streamEffectForEvent("ended", { type: "live_stream.deleted" }).kind).toBe("ignore");
    expect(streamEffectForEvent("active", { type: "live_stream.errored" })).toEqual({ kind: "transition", to: "failed", reason: "provider_error" });
    expect(streamEffectForEvent("ended", { type: "asset.ready", assetId: "asset-1" })).toEqual({ kind: "recording", assetId: "asset-1" });
    expect(streamEffectForEvent("ended", { type: "asset.ready" })).toEqual({ kind: "ignore", reason: "missing_asset" });
    expect(streamEffectForEvent("active", { type: "unknown.thing" }).kind).toBe("ignore");
  });

  it("exposes a playback id publicly only when published", () => {
    expect(publicEmbed({ status: "active", published: false, playbackId: "p" })).toBeNull();
    expect(publicEmbed({ status: "failed", published: true, playbackId: "p" })).toBeNull();
    expect(publicEmbed({ status: "active", published: true, playbackId: null })).toBeNull();
    expect(publicEmbed({ status: "active", published: true, playbackId: "p" })).toEqual({ status: "active", playbackId: "p", live: true });
  });
});
