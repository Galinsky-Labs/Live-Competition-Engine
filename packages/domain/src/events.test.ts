import { describe, expect, it } from "vitest";
import {
  applyEventPatch,
  canTransition,
  EVENT_DEFAULTS,
  EVENT_STATUSES,
  isValidTimeZone,
  parseEventCreate,
  parseEventPatch,
  planTransition,
  type EventFields
} from "./events.ts";

const ready: EventFields = {
  ...EVENT_DEFAULTS, title: "Event", slug: "spring-open", startsAt: new Date("2027-03-01T18:00:00Z"), venueName: "Hall"
};

describe("event lifecycle", () => {
  it("allows exactly the documented transitions", () => {
    const allowed = new Set(["draft>published", "draft>cancelled", "published>live", "published>completed",
      "published>cancelled", "live>paused", "live>completed", "live>cancelled", "paused>live", "paused>completed",
      "paused>cancelled"]);
    for (const from of EVENT_STATUSES) {
      for (const to of EVENT_STATUSES) expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
    }
  });

  it("requires a reason to cancel and publishable fields to publish", () => {
    expect(() => planTransition("draft", "cancelled", ready, null)).toThrow("cancel_reason_required");
    expect(planTransition("draft", "cancelled", ready, "Venue closed").reason).toBe("Venue closed");
    expect(() => planTransition("draft", "published", { ...ready, slug: null }, null)).toThrow("event_not_publishable_slug_required");
    expect(() => planTransition("draft", "published", { ...ready, startsAt: null }, null)).toThrow("event_not_publishable_start_required");
    expect(() => planTransition("draft", "published", { ...ready, venueName: null }, null)).toThrow("event_not_publishable_location_required");
    expect(() => planTransition("completed", "live", ready, null)).toThrow("invalid_state_transition");
    expect(planTransition("draft", "published", { ...ready, venueName: null, streamUrl: "https://stream.example/x" }, null).reason).toBeNull();
  });
});

describe("event fields", () => {
  it("validates IANA time zones", () => {
    for (const tz of ["UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires"]) expect(isValidTimeZone(tz)).toBe(true);
    for (const tz of ["Mars/Base", "", "../etc", "x".repeat(65), 5]) expect(isValidTimeZone(tz)).toBe(false);
  });

  it("parses a create body with defaults and rejects unknown or invalid fields", () => {
    const fields = parseEventCreate({ title: "Open", capacity: 200, startsAt: "2027-01-01T10:00:00Z" });
    expect(fields.visibility).toBe("private");
    expect(fields.timezone).toBe("UTC");
    expect(fields.startsAt?.toISOString()).toBe("2027-01-01T10:00:00.000Z");
    for (const [body, code] of [
      [{}, "invalid_title"],
      [{ title: "x", owner: "me" }, "invalid_event_field"],
      [{ title: "x", slug: "Bad Slug" }, "invalid_slug"],
      [{ title: "x", capacity: 0 }, "invalid_capacity"],
      [{ title: "x", streamUrl: "http://insecure.example" }, "invalid_stream_url"],
      [{ title: "x", streamUrl: "https://user:pw@host.example" }, "invalid_stream_url"],
      [{ title: "x", timezone: "Nowhere/City" }, "invalid_timezone"],
      [{ title: "x", startsAt: "2027-01-02T00:00:00Z", endsAt: "2027-01-01T00:00:00Z" }, "invalid_schedule"],
      [{ title: "x", startsAt: "tomorrow" }, "invalid_starts_at"],
      [{ title: "x", venueAddress: "1 Main St" }, "invalid_venue"]
    ] as const) {
      expect(() => parseEventCreate(body as Record<string, unknown>)).toThrow(code);
    }
  });

  it("locks slugs after publication and closes edits on terminal states", () => {
    expect(applyEventPatch("draft", ready, parseEventPatch({ slug: "renamed" })).slug).toBe("renamed");
    expect(() => applyEventPatch("published", ready, { slug: "renamed" })).toThrow("invalid_state_slug_locked");
    expect(applyEventPatch("published", ready, { capacity: 50 }).capacity).toBe(50);
    expect(() => applyEventPatch("published", ready, { venueName: null })).toThrow("event_not_publishable_location_required");
    expect(() => applyEventPatch("completed", ready, { capacity: 50 })).toThrow("invalid_state_event_closed");
    expect(() => applyEventPatch("cancelled", ready, { capacity: 50 })).toThrow("invalid_state_event_closed");
  });
});
