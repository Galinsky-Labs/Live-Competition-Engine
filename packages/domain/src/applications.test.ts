import { describe, expect, it } from "vitest";
import {
  applicationStatuses, assertCapacity, assertTransition, assertWindowOpen, canTransition,
  decisionRequiresReason, nextToPromote, parseApplicationForm, validateAnswers, validateDisplayName, validateReason,
  type ApplicationActor
} from "./applications";

const form = () => parseApplicationForm({
  opensAt: "2026-01-01T00:00:00Z",
  closesAt: "2026-02-01T00:00:00Z",
  capacity: 2,
  contactConsentKey: "share_contact",
  fields: [
    { key: "bio", type: "text", label: "Short bio", required: true, maxLength: 20 },
    { key: "notes", type: "text", label: "Notes", multiline: true },
    { key: "category", type: "choice", label: "Category", required: true, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { key: "tags", type: "choice", label: "Tags", multiple: true, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
    { key: "sample", type: "media", label: "Sample", maxItems: 2 },
    { key: "rules", type: "consent", label: "I accept the rules", required: true, consentVersion: "rules-v1" },
    { key: "share_contact", type: "consent", label: "Share my email", consentVersion: "contact-v1" }
  ]
});
const media = "00000000-0000-4000-8000-000000000001";

describe("application form schema", () => {
  it("parses a bounded form with defaults", () => {
    const parsed = form();
    expect(parsed.fields).toHaveLength(7);
    expect(parsed.fields[1]).toMatchObject({ type: "text", maxLength: 500, multiline: true, required: false });
    expect(parsed.capacity).toBe(2);
  });

  it.each([
    ["closing before opening", { opensAt: "2026-02-01T00:00:00Z", closesAt: "2026-01-01T00:00:00Z", fields: [] }],
    ["invalid dates", { opensAt: "soon", closesAt: "2026-01-01T00:00:00Z", fields: [] }],
    ["duplicate keys", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [
      { key: "a", type: "text", label: "A" }, { key: "a", type: "text", label: "B" }] }],
    ["unknown type", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [{ key: "a", type: "file", label: "A" }] }],
    ["bad key", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [{ key: "A b", type: "text", label: "A" }] }],
    ["too long text", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [{ key: "a", type: "text", label: "A", maxLength: 9999 }] }],
    ["empty choices", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [{ key: "a", type: "choice", label: "A", options: [] }] }],
    ["duplicate choices", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [{ key: "a", type: "choice", label: "A", options: [{ value: "x", label: "X" }, { value: "x", label: "Y" }] }] }],
    ["too many media", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [{ key: "a", type: "media", label: "A", maxItems: 6 }] }],
    ["bad consent version", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: [{ key: "a", type: "consent", label: "A", consentVersion: "" }] }],
    ["contact consent not a consent field", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", contactConsentKey: "a", fields: [{ key: "a", type: "text", label: "A" }] }],
    ["zero capacity", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", capacity: 0, fields: [] }],
    ["too many fields", { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z", fields: Array.from({ length: 51 }, (_, i) => ({ key: `f${i}`, type: "text", label: "x" })) }],
    ["not an object", null]
  ])("rejects %s", (_name, input) => {
    expect(() => parseApplicationForm(input)).toThrowError(expect.objectContaining({ code: "invalid_application_form" }));
  });
});

describe("answers", () => {
  it("accepts a partial draft and normalizes consents and media", () => {
    const result = validateAnswers(form(), { bio: "hi", sample: [media.toUpperCase()], share_contact: true }, { complete: false });
    expect(result.answers).toEqual({ bio: "hi", sample: [media], share_contact: true });
    expect(result.consents).toEqual([{ key: "share_contact", version: "contact-v1" }]);
    expect(result.media).toEqual([{ fieldKey: "sample", mediaId: media }]);
  });

  it("requires required fields and consents on submit", () => {
    expect(() => validateAnswers(form(), { bio: "hi", category: "a" }, { complete: true }))
      .toThrowError(expect.objectContaining({ code: "application_incomplete" }));
    expect(() => validateAnswers(form(), { bio: "hi", category: "a", rules: false }, { complete: true }))
      .toThrowError(expect.objectContaining({ code: "application_incomplete" }));
    const ok = validateAnswers(form(), { bio: "hi", category: "a", rules: true, tags: ["x", "y"] }, { complete: true });
    expect(ok.consents).toEqual([{ key: "rules", version: "rules-v1" }]);
    expect(ok.answers.tags).toEqual(["x", "y"]);
  });

  it.each([
    ["unknown key", { other: "x" }],
    ["too long", { bio: "x".repeat(21) }],
    ["newline in single-line text", { bio: "a\nb" }],
    ["control character", { notes: "a\u0000" }],
    ["choice outside options", { category: "z" }],
    ["array for single choice", { category: ["a"] }],
    ["duplicate multi choice", { tags: ["x", "x"] }],
    ["media not uuid", { sample: ["nope"] }],
    ["too many media", { sample: [media, "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"] }],
    ["duplicate media", { sample: [media, media] }],
    ["consent not boolean true", { rules: "yes" }],
    ["array input", []]
  ])("rejects %s", (_name, answers) => {
    expect(() => validateAnswers(form(), answers, { complete: false }))
      .toThrowError(expect.objectContaining({ code: "invalid_application_answers" }));
  });

  it("validates display names", () => {
    expect(validateDisplayName("  Ada ")).toBe("Ada");
    expect(() => validateDisplayName("")).toThrow();
    expect(() => validateDisplayName("a\nb")).toThrow();
    expect(() => validateDisplayName("x".repeat(121))).toThrow();
  });
});

describe("application window", () => {
  it("enforces opening and deadline server-side", () => {
    const f = form();
    expect(() => assertWindowOpen(f, new Date("2025-12-31T23:59:59Z"))).toThrowError(expect.objectContaining({ code: "application_window_not_open" }));
    expect(() => assertWindowOpen(f, new Date("2026-01-01T00:00:00Z"))).not.toThrow();
    expect(() => assertWindowOpen(f, new Date("2026-02-01T00:00:00Z"))).toThrowError(expect.objectContaining({ code: "application_deadline_passed" }));
  });
});

describe("status machine", () => {
  const actors: ApplicationActor[] = ["applicant", "producer", "system"];
  const allowed = new Set([
    "draft>submitted>applicant", "draft>withdrawn>applicant",
    "submitted>under_review>producer", "submitted>selected>producer", "submitted>waitlisted>producer",
    "submitted>declined>producer", "submitted>withdrawn>applicant",
    "under_review>selected>producer", "under_review>waitlisted>producer", "under_review>declined>producer",
    "under_review>withdrawn>applicant",
    "waitlisted>selected>producer", "waitlisted>selected>system", "waitlisted>declined>producer", "waitlisted>withdrawn>applicant",
    "selected>withdrawn>applicant",
    "declined>under_review>producer"
  ]);
  it("allows exactly the documented transitions", () => {
    for (const from of applicationStatuses) for (const to of applicationStatuses) for (const actor of actors) {
      expect(canTransition(from, to, actor), `${from}>${to}>${actor}`).toBe(allowed.has(`${from}>${to}>${actor}`));
    }
    expect(() => assertTransition("withdrawn", "submitted", "applicant")).toThrowError(expect.objectContaining({ code: "invalid_state_transition" }));
  });

  it("requires reasons for declines and reopenings", () => {
    expect(decisionRequiresReason("submitted", "declined")).toBe(true);
    expect(decisionRequiresReason("declined", "under_review")).toBe(true);
    expect(decisionRequiresReason("submitted", "selected")).toBe(false);
    expect(() => validateReason(undefined, true)).toThrowError(expect.objectContaining({ code: "decision_reason_required" }));
    expect(validateReason(undefined, false)).toBeNull();
    expect(() => validateReason("x".repeat(1001), false)).toThrowError(expect.objectContaining({ code: "invalid_decision_reason" }));
  });
});

describe("waitlist and capacity", () => {
  it("promotes the lowest position, then the earliest", () => {
    const at = (s: number) => new Date(s * 1000);
    expect(nextToPromote([
      { id: "c", waitlistPosition: 2, waitlistedAt: at(1) },
      { id: "b", waitlistPosition: 1, waitlistedAt: at(5) },
      { id: "a", waitlistPosition: 1, waitlistedAt: at(3) },
      { id: "z", waitlistPosition: null, waitlistedAt: null }
    ])?.id).toBe("a");
    expect(nextToPromote([])).toBeNull();
  });

  it("refuses selection beyond capacity", () => {
    expect(() => assertCapacity(2, 2)).toThrowError(expect.objectContaining({ code: "selection_capacity_conflict" }));
    expect(() => assertCapacity(2, 1)).not.toThrow();
    expect(() => assertCapacity(null, 999)).not.toThrow();
  });
});
