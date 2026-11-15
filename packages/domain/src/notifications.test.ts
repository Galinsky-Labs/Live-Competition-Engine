import { describe, expect, it } from "vitest";
import { computeBackoffMs, outcomeAfterFailure, summarizeError } from "./jobs";
import { defaultPreference, evaluateConsent, parseNotificationInput, parsePreferences } from "./notifications";

const base = { activeMember: true, featureEnabled: true, preference: null, category: "results" as const, channel: "email" as const, hasEmail: true, suppressed: false };

describe("job retry policy", () => {
  it("grows exponentially with bounded jitter and a cap", () => {
    expect(computeBackoffMs(1, 1000, () => 0)).toBe(500);
    expect(computeBackoffMs(1, 1000, () => 1)).toBe(1000);
    expect(computeBackoffMs(4, 1000, () => 1)).toBe(8000);
    expect(computeBackoffMs(40, 1000, () => 1)).toBe(6 * 3600 * 1000);
    expect(() => computeBackoffMs(0, 1000)).toThrow();
  });

  it("dies after max attempts or on permanent errors", () => {
    expect(outcomeAfterFailure(5, 5, 1000, false)).toEqual({ status: "dead" });
    expect(outcomeAfterFailure(1, 5, 1000, true)).toEqual({ status: "dead" });
    expect(outcomeAfterFailure(2, 5, 1000, false, () => 0)).toEqual({ status: "queued", delayMs: 1000 });
    expect(summarizeError(new Error("a\nb"))).toBe("Error: a b");
  });
});

describe("notification consent", () => {
  it("defaults marketing off and everything else on", () => {
    expect(defaultPreference("marketing", "in_app")).toBe(false);
    expect(defaultPreference("results", "email")).toBe(true);
    expect(evaluateConsent({ ...base, category: "marketing" })).toEqual({ allowed: false, reason: "preference_off" });
    expect(evaluateConsent({ ...base, category: "marketing", preference: true })).toEqual({ allowed: true });
  });

  it("fails closed on membership, feature, preference, missing or suppressed address", () => {
    expect(evaluateConsent({ ...base, activeMember: false })).toEqual({ allowed: false, reason: "not_member" });
    expect(evaluateConsent({ ...base, featureEnabled: false })).toEqual({ allowed: false, reason: "feature_disabled" });
    expect(evaluateConsent({ ...base, preference: false })).toEqual({ allowed: false, reason: "preference_off" });
    expect(evaluateConsent({ ...base, hasEmail: false })).toEqual({ allowed: false, reason: "no_email" });
    expect(evaluateConsent({ ...base, suppressed: true })).toEqual({ allowed: false, reason: "suppressed" });
    expect(evaluateConsent({ ...base, channel: "in_app", hasEmail: false, suppressed: true })).toEqual({ allowed: true });
  });

  it("validates notification and preference input", () => {
    expect(() => parseNotificationInput({ category: "results", title: "T", idempotencyKey: "k", link: "https://evil" })).toThrow("invalid_link");
    expect(() => parseNotificationInput({ category: "spam", title: "T", idempotencyKey: "k" })).toThrow("invalid_category");
    expect(parseNotificationInput({ category: "results", title: "T", idempotencyKey: "k", link: "/x" }).link).toBe("/x");
    expect(() => parsePreferences([{ category: "results", channel: "sms", enabled: true }])).toThrow("invalid_channel");
  });
});
