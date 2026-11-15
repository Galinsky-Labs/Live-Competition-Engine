import { describe, expect, it } from "vitest";
import { canTransitionSubscription, endedStatus, validateConsent, validatePlanInput } from "./subscriptions.ts";
import { remainingCapacity, salesOpen, validateTicketTypeInput } from "./ticketing.ts";

const plan = { termsVersion: "2026-11", priceMinor: 500, currency: "USD", interval: "month" };

describe("subscription domain", () => {
  it("allows only the explicit lifecycle", () => {
    expect(canTransitionSubscription("incomplete", "active")).toBe(true);
    expect(canTransitionSubscription("active", "past_due")).toBe(true);
    expect(canTransitionSubscription("past_due", "active")).toBe(true);
    expect(canTransitionSubscription("cancelled", "active")).toBe(false);
    expect(canTransitionSubscription("expired", "active")).toBe(false);
    expect(canTransitionSubscription("incomplete", "past_due")).toBe(false);
    expect(endedStatus("past_due")).toBe("expired");
    expect(endedStatus("active")).toBe("cancelled");
  });

  it("requires consent to the exact terms, price and interval", () => {
    expect(validateConsent({ accepted: true, termsVersion: "2026-11", priceMinor: 500, currency: "usd", interval: "month" }, plan)).toEqual({ termsVersion: "2026-11" });
    expect(() => validateConsent(undefined, plan)).toThrow("consent_required");
    expect(() => validateConsent({ accepted: "yes" }, plan)).toThrow("consent_required");
    expect(() => validateConsent({ accepted: true, termsVersion: "2026-10", priceMinor: 500, currency: "USD", interval: "month" }, plan)).toThrow("consent_terms_conflict");
    expect(() => validateConsent({ accepted: true, termsVersion: "2026-11", priceMinor: 500, currency: "USD", interval: "year" }, plan)).toThrow("consent_price_conflict");
  });

  it("validates plans", () => {
    expect(validatePlanInput({ name: "Fans", priceMinor: 100, currency: "eur", interval: "year", termsVersion: "v1" }).creatorType).toBe("tenant");
    expect(() => validatePlanInput({ creatorType: "participant", name: "Fans", priceMinor: 100, currency: "eur", interval: "year", termsVersion: "v1" })).toThrow("invalid_creator");
    expect(() => validatePlanInput({ name: "Fans", priceMinor: 100, currency: "eur", interval: "year", termsVersion: "bad terms!" })).toThrow("invalid_terms_version");
  });
});

describe("ticketing domain", () => {
  it("validates ticket types and sales windows", () => {
    const type = validateTicketTypeInput({ name: "GA", priceMinor: 0, currency: "usd", capacity: 2, salesStartsAt: "2026-01-01T00:00:00Z", salesEndsAt: "2026-02-01T00:00:00Z" });
    expect(type.priceMinor).toBe(0);
    expect(() => validateTicketTypeInput({ name: "GA", priceMinor: 1, currency: "usd", capacity: 0 })).toThrow("invalid_capacity");
    expect(() => validateTicketTypeInput({ name: "GA", priceMinor: 1, currency: "usd", salesStartsAt: "2026-02-01", salesEndsAt: "2026-01-01" })).toThrow("invalid_sales_window");
    expect(() => validateTicketTypeInput({ kind: "vip", name: "GA", priceMinor: 1, currency: "usd" })).toThrow("invalid_ticket_kind");
    expect(salesOpen({ status: "on_sale", ...type }, new Date("2026-01-15"))).toBe(true);
    expect(salesOpen({ status: "on_sale", ...type }, new Date("2026-02-01"))).toBe(false);
    expect(salesOpen({ status: "paused", ...type }, new Date("2026-01-15"))).toBe(false);
    expect(remainingCapacity({ capacity: 3, reserved: 5 })).toBe(0);
    expect(remainingCapacity({ capacity: null, reserved: 5 })).toBe(null);
  });
});
