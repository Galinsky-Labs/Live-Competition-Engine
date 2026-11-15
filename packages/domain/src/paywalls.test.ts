import { describe, expect, it } from "vitest";
import { decideContentAccess, validateContentInput } from "./paywalls.ts";

const base = { paywallsEnabled: true, isOwnerOrManager: false, isSupporter: false, hasPlan: false, hasPurchase: false };
const creator = "11111111-1111-4111-8111-111111111111";

describe("content access decisions", () => {
  it("public content is always full, even with paywalls disabled", () => {
    expect(decideContentAccess({ ...base, rule: "public", paywallsEnabled: false })).toBe("full");
  });

  it("gated content is hidden (not given away, no price) when paywalls are disabled", () => {
    for (const rule of ["members", "plan", "purchase"] as const) {
      expect(decideContentAccess({ ...base, rule, paywallsEnabled: false, hasPurchase: true, isSupporter: true, hasPlan: true })).toBe("hidden");
    }
  });

  it("each rule requires its own entitlement", () => {
    expect(decideContentAccess({ ...base, rule: "members" })).toBe("teaser");
    expect(decideContentAccess({ ...base, rule: "members", isSupporter: true })).toBe("full");
    expect(decideContentAccess({ ...base, rule: "plan", isSupporter: true })).toBe("teaser");
    expect(decideContentAccess({ ...base, rule: "plan", hasPlan: true })).toBe("full");
    expect(decideContentAccess({ ...base, rule: "purchase", hasPlan: true })).toBe("teaser");
    expect(decideContentAccess({ ...base, rule: "purchase", hasPurchase: true })).toBe("full");
    expect(decideContentAccess({ ...base, rule: "purchase", isOwnerOrManager: true })).toBe("full");
  });

  it("validates content input", () => {
    expect(validateContentInput({ creatorType: "account", creatorId: creator, title: "Free", body: "Hello" }).accessRule).toBe("public");
    expect(validateContentInput({ title: "Paid", body: "x", accessRule: "purchase", priceMinor: 100, currency: "usd" }).currency).toBe("USD");
    expect(() => validateContentInput({ title: "Paid", body: "x", accessRule: "purchase" })).toThrow("invalid_amount");
    expect(() => validateContentInput({ title: "Free", body: "x", priceMinor: 5 })).toThrow("invalid_amount");
    expect(() => validateContentInput({ title: "Plan", body: "x", accessRule: "plan" })).toThrow("invalid_plan");
    expect(() => validateContentInput({ title: "Media", kind: "media", body: "x", mediaId: creator })).toThrow("invalid_body");
    expect(() => validateContentInput({ title: "", body: "x" })).toThrow("invalid_title");
  });
});
