import { describe, expect, it } from "vitest";
import { formatInZone } from "./format";

describe("formatInZone", () => {
  it("formats in the event time zone and handles missing dates", () => {
    expect(formatInZone(null, "UTC")).toBe("To be announced");
    expect(formatInZone("2026-12-01T19:00:00Z", "America/New_York")).toMatch(/2:00:00 PM EST/);
  });
});
