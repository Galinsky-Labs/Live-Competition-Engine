import { describe, expect, it, vi } from "vitest";
import type { PublicOverlay } from "@live-competition-engine/db/broadcast";
import { COMP, ORG } from "../../../../../../../../lib/live-test-helpers";
import { createPublicBroadcastHandlers } from "./handler";

const overlay: PublicOverlay = {
  competition: { title: "Show" },
  show: { state: "running" },
  sequence: 7,
  current: { displayName: "Entrant A", roundLabel: "Round 1" },
  next: null,
  timer: { label: "Set", status: "running", durationMs: 60_000, extendedMs: 0, elapsedBeforeMs: 0, runningSince: 1_000, sequence: 1 },
  lowerThird: null,
  caption: null
};

const get = (headers: Record<string, string> = {}) => new Request("https://engine.test/x", { headers });

describe("public broadcast handlers", () => {
  it("serves overlay data with sequence, serverNow and cache headers", async () => {
    let now = 11_000;
    const handlers = createPublicBroadcastHandlers({ getPublicOverlay: vi.fn(async () => overlay), getPublicScoreboard: vi.fn(), clock: () => now });
    const response = await handlers.overlay(get(), ORG, COMP);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ sequence: 7, serverNow: 11_000, timerRemainingMs: 50_000 });
    expect(response.headers.get("cache-control")).toMatch(/^public, max-age=1/);
    expect(response.headers.get("x-server-now")).toBe("11000");
    const etag = response.headers.get("etag")!;
    // The timer keeps running but the stable content (and ETag) does not change.
    now = 12_000;
    const cached = await handlers.overlay(get({ "if-none-match": etag }), ORG, COMP);
    expect(cached.status).toBe(304);
    expect(cached.headers.get("x-server-now")).toBe("12000");
    expect(await cached.text()).toBe("");
  });

  it("changes the ETag when content changes", async () => {
    const source = vi.fn(async () => overlay);
    const handlers = createPublicBroadcastHandlers({ getPublicOverlay: source, getPublicScoreboard: vi.fn() });
    const first = (await handlers.overlay(get(), ORG, COMP)).headers.get("etag")!;
    source.mockResolvedValueOnce({ ...overlay, sequence: 8, caption: { text: "Hello" } });
    const changed = await handlers.overlay(get({ "if-none-match": first }), ORG, COMP);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(first);
  });

  it("returns a public 404 for private or unknown competitions without leaking why", async () => {
    const handlers = createPublicBroadcastHandlers({ getPublicOverlay: vi.fn(async () => null), getPublicScoreboard: vi.fn(async () => null) });
    for (const response of [await handlers.overlay(get(), ORG, COMP), await handlers.scoreboard(get(), ORG, COMP)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("serves the scoreboard with a longer cache window", async () => {
    const handlers = createPublicBroadcastHandlers({
      getPublicOverlay: vi.fn(),
      getPublicScoreboard: vi.fn(async () => ({ competition: { title: "Show" }, sequence: 3, rounds: [] }))
    });
    const response = await handlers.scoreboard(get(), ORG, COMP);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toMatch(/max-age=5/);
    expect(response.headers.get("vary")).toBeNull();
  });
});
