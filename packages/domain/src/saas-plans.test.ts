import { describe, expect, it } from "vitest";
import {
  addInterval,
  assertSubscriptionTransition,
  canTransitionSubscription,
  classifyPlanChange,
  computeProration,
  evaluateLimit,
  limitViolations,
  nextSubscriptionStep,
  parseUsagePeriod,
  usagePeriodStart,
  validatePlanDefinition
} from "./saas-plans";

const features = new Set(["voting", "chat", "custom_domains"]);
const isFeature = (v: string) => features.has(v);
const limits = { max_events_per_month: 5, max_storage_bytes: 1000, max_members: 10, max_custom_domains: null };
const valid = {
  planKey: "starter", name: "Starter", currency: "USD", billingInterval: "month",
  priceMinor: 2900, trialDays: 14, features: ["voting", "chat", "voting"], limits
};

describe("plan definitions", () => {
  it("normalizes a valid plan", () => {
    const plan = validatePlanDefinition(valid, isFeature);
    expect(plan.features).toEqual(["chat", "voting"]);
    expect(plan.limits.max_custom_domains).toBeNull();
  });

  it.each([
    { planKey: "Bad Key" }, { currency: "usd" }, { billingInterval: "week" }, { priceMinor: -1 },
    { priceMinor: 1.5 }, { trialDays: 91 }, { features: ["not_a_feature"] },
    { limits: { ...limits, unknown_limit: 1 } }, { limits: { max_members: 1 } }, { name: "" }
  ])("rejects %o", patch => {
    expect(() => validatePlanDefinition({ ...valid, ...patch }, isFeature)).toThrow("invalid_plan");
  });
});

describe("plan changes and proration", () => {
  const base = { currency: "USD", billingInterval: "month" as const, limits };
  it("classifies by price and refuses currency or interval changes", () => {
    expect(classifyPlanChange({ ...base, priceMinor: 100 }, { ...base, priceMinor: 200 })).toBe("upgrade");
    expect(classifyPlanChange({ ...base, priceMinor: 200 }, { ...base, priceMinor: 100 })).toBe("downgrade");
    expect(classifyPlanChange({ ...base, priceMinor: 100 }, { ...base, priceMinor: 100 })).toBe("lateral");
    expect(() => classifyPlanChange({ ...base, priceMinor: 1 }, { ...base, currency: "EUR", priceMinor: 2 })).toThrow("plan_change_currency_mismatch");
    expect(() => classifyPlanChange({ ...base, priceMinor: 1 }, { ...base, billingInterval: "year", priceMinor: 2 })).toThrow("plan_change_interval_mismatch");
  });

  it("prorates the remaining fraction exactly", () => {
    const periodStart = new Date("2026-01-01T00:00:00Z");
    const periodEnd = new Date("2026-01-31T00:00:00Z");
    const changeAt = new Date("2026-01-16T00:00:00Z");
    const p = computeProration({ fromPriceMinor: 3000, toPriceMinor: 9000, periodStart, periodEnd, changeAt });
    expect(p).toMatchObject({ creditMinor: 1500, chargeMinor: 4500, netMinor: 3000 });
  });

  it("clamps outside the period and rounds half up", () => {
    const periodStart = new Date(0);
    const periodEnd = new Date(3);
    expect(computeProration({ fromPriceMinor: 0, toPriceMinor: 1, periodStart, periodEnd, changeAt: new Date(-5) }).chargeMinor).toBe(1);
    expect(computeProration({ fromPriceMinor: 0, toPriceMinor: 1, periodStart, periodEnd, changeAt: new Date(10) }).chargeMinor).toBe(0);
    // 3 * (1.5/3) = 1.5 -> 2 (half up)
    expect(computeProration({ fromPriceMinor: 0, toPriceMinor: 3, periodStart: new Date(0), periodEnd: new Date(2), changeAt: new Date(1) }).chargeMinor).toBe(2);
  });

  it("does not overflow on large amounts and long periods", () => {
    const p = computeProration({
      fromPriceMinor: 0, toPriceMinor: 100_000_000_000,
      periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2027-01-01T00:00:00Z"),
      changeAt: new Date("2026-07-02T12:00:00Z")
    });
    expect(p.chargeMinor).toBe(50_000_000_000);
  });

  it("rejects invalid proration input", () => {
    expect(() => computeProration({ fromPriceMinor: 1, toPriceMinor: 2, periodStart: new Date(5), periodEnd: new Date(5), changeAt: new Date(5) })).toThrow("invalid_proration");
  });
});

describe("limits", () => {
  it("reports violations and treats missing limits as zero", () => {
    expect(limitViolations({ max_members: 11, max_custom_domains: 99 }, limits)).toEqual([{ limitKey: "max_members", limit: 10, current: 11 }]);
    expect(limitViolations({ max_members: 1 }, {})).toEqual([{ limitKey: "max_members", limit: 0, current: 1 }]);
  });

  it("evaluates increments", () => {
    expect(evaluateLimit(limits, "max_events_per_month", 4, 1)).toMatchObject({ allowed: true, remaining: 1 });
    expect(evaluateLimit(limits, "max_events_per_month", 5, 1)).toMatchObject({ allowed: false, remaining: 0 });
    expect(evaluateLimit(limits, "max_custom_domains", 1e9, 1)).toMatchObject({ allowed: true, remaining: null });
    expect(() => evaluateLimit(limits, "max_members", 0, -1)).toThrow("invalid_limit_increment");
  });
});

describe("subscription lifecycle", () => {
  it("enforces explicit transitions", () => {
    expect(canTransitionSubscription("trialing", "active")).toBe(true);
    expect(canTransitionSubscription("past_due", "active")).toBe(true);
    expect(canTransitionSubscription("cancelled", "active")).toBe(false);
    expect(canTransitionSubscription("active", "trialing")).toBe(false);
    expect(() => assertSubscriptionTransition("cancelled", "past_due")).toThrow("invalid_state_subscription_transition");
  });

  it("adds intervals with month-end clamping", () => {
    expect(addInterval(new Date("2026-01-31T10:00:00Z"), "month").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addInterval(new Date("2024-02-29T00:00:00Z"), "year").toISOString()).toBe("2025-02-28T00:00:00.000Z");
    expect(addInterval(new Date("2026-12-15T00:00:00Z"), "month").toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("computes usage periods", () => {
    expect(usagePeriodStart(new Date("2026-03-31T23:59:59Z")).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(parseUsagePeriod("2026-11").toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(() => parseUsagePeriod("2026-13")).toThrow("invalid_usage_period");
  });

  it("plans the next due step", () => {
    const snapshot = {
      status: "trialing" as const, planPriceMinor: 1000, billingInterval: "month" as const,
      trialEndsAt: new Date("2026-01-15T00:00:00Z"),
      currentPeriodStart: new Date("2026-01-01T00:00:00Z"), currentPeriodEnd: new Date("2026-01-15T00:00:00Z"),
      pendingPlan: null
    };
    expect(nextSubscriptionStep(snapshot, new Date("2026-01-10T00:00:00Z"))).toBeNull();
    expect(nextSubscriptionStep(snapshot, new Date("2026-01-15T00:00:00Z"))).toMatchObject({ kind: "trial_ended", chargeMinor: 1000 });
    const active = { ...snapshot, status: "active" as const, pendingPlan: { id: "p2", priceMinor: 500 } };
    expect(nextSubscriptionStep(active, new Date("2026-02-01T00:00:00Z"))).toMatchObject({ kind: "downgrade_applied", planId: "p2", chargeMinor: 500 });
    expect(nextSubscriptionStep({ ...active, pendingPlan: null }, new Date("2026-02-01T00:00:00Z"))).toMatchObject({ kind: "renewed" });
    expect(nextSubscriptionStep({ ...active, status: "cancelled" }, new Date("2030-01-01T00:00:00Z"))).toBeNull();
  });
});
