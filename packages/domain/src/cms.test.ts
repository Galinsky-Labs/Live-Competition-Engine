import { describe, expect, it } from "vitest";
import { parseNavigation, parsePageContent, parsePublishAt, parseSlug } from "./cms";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("cms input rules", () => {
  it("validates slugs", () => {
    expect(parseSlug("about-us")).toBe("about-us");
    for (const bad of ["About", "-x", "a--b", "a/b", "", "x".repeat(81)]) expect(() => parseSlug(bad)).toThrow("invalid_slug");
  });

  it("validates content and de-duplicates media references", () => {
    expect(parsePageContent({ title: " Hi ", body: "x", mediaIds: [uuid, uuid] })).toEqual({ title: "Hi", body: "x", mediaIds: [uuid] });
    expect(() => parsePageContent({ title: "" })).toThrow("invalid_title");
    expect(() => parsePageContent({ title: "t", mediaIds: ["x"] })).toThrow("invalid_media_ids");
  });

  it("requires future schedule times within a year", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(parsePublishAt("2026-02-01T00:00:00Z", now).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(() => parsePublishAt("2025-12-31T00:00:00Z", now)).toThrow("invalid_publish_at");
    expect(() => parsePublishAt("2028-01-01T00:00:00Z", now)).toThrow("invalid_publish_at");
  });

  it("validates navigation targets", () => {
    expect(parseNavigation([{ label: "About", pageId: uuid }, { label: "Site", url: "https://example.org" }]))
      .toEqual([{ label: "About", pageId: uuid, url: null, position: 0 }, { label: "Site", pageId: null, url: "https://example.org", position: 1 }]);
    expect(() => parseNavigation([{ label: "x", url: "javascript:alert(1)" }])).toThrow("invalid_navigation_target");
    expect(() => parseNavigation([{ label: "x", url: "https://a.org", pageId: uuid }])).toThrow("invalid_navigation_target");
  });
});
