import { describe, expect, it } from "vitest";
import {
  checkSlug,
  computeOnboardingChecklist,
  normalizeEmail,
  validateFirstEvent,
  validateSignup
} from "./tenant-signup";

describe("signup validation", () => {
  it("normalizes valid input", () => {
    expect(validateSignup({ email: " Owner@Example.ORG ", organizationName: "  Night   League ", slug: "Night-League" }))
      .toEqual({ email: "owner@example.org", organizationName: "Night League", slug: "night-league", planKey: null });
  });

  it.each(["", "no-at", "a@b", "a b@example.org", "x@-bad.org", `${"a".repeat(65)}@example.org`])("rejects email %s", email => {
    expect(() => normalizeEmail(email)).toThrow("invalid_email");
  });

  it("checks slugs including reserved names", () => {
    expect(checkSlug("ab")).toEqual({ ok: false, reason: "invalid_slug" });
    expect(checkSlug("-abc")).toEqual({ ok: false, reason: "invalid_slug" });
    expect(checkSlug("a--b")).toEqual({ ok: false, reason: "invalid_slug" });
    expect(checkSlug("x".repeat(41))).toEqual({ ok: false, reason: "invalid_slug" });
    expect(checkSlug("admin")).toEqual({ ok: false, reason: "slug_reserved" });
    expect(checkSlug("Platform")).toEqual({ ok: false, reason: "slug_reserved" });
    expect(checkSlug("fx-anything")).toEqual({ ok: false, reason: "slug_reserved" });
    expect(checkSlug("city-finals-2026")).toEqual({ ok: true, slug: "city-finals-2026" });
  });

  it("rejects bad names and plan keys", () => {
    expect(() => validateSignup({ email: "a@example.org", organizationName: "x", slug: "abc" })).toThrow("invalid_organization_name");
    expect(() => validateSignup({ email: "a@example.org", organizationName: "Org", slug: "abc", planKey: "Bad Key" })).toThrow("invalid_plan_key");
    expect(() => validateSignup(null)).toThrow("invalid_signup");
  });
});

describe("onboarding checklist", () => {
  const facts = {
    emailVerified: false, hasActiveTheme: false, domainClaims: 0, activeMembers: 1,
    paymentSetupComplete: null, firstEventId: null, eventCount: 0, skippedSteps: [] as string[]
  };

  it("starts pending with payment external", () => {
    const list = computeOnboardingChecklist(facts);
    expect(list.completed).toBe(0);
    expect(list.ready).toBe(false);
    expect(list.steps.find(s => s.key === "payment_setup")?.status).toBe("external_pending");
  });

  it("is ready when required steps are done and optional ones skipped or complete", () => {
    const list = computeOnboardingChecklist({
      ...facts, emailVerified: true, hasActiveTheme: true, eventCount: 1, activeMembers: 3,
      skippedSteps: ["custom_domain_claimed", "email_verified"]
    });
    expect(list.steps.find(s => s.key === "custom_domain_claimed")?.status).toBe("skipped");
    expect(list.ready).toBe(true);
    expect(computeOnboardingChecklist({ ...facts, skippedSteps: ["email_verified"] }).steps[0]?.status).toBe("pending");
  });
});

describe("first event", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  it("validates title and start", () => {
    expect(validateFirstEvent({ title: " Opening night " }, now)).toEqual({ title: "Opening night", description: null, startsAt: null });
    expect(() => validateFirstEvent({ title: "x" }, now)).toThrow("invalid_event_title");
    expect(() => validateFirstEvent({ title: "Show", startsAt: "2020-01-01T00:00:00Z" }, now)).toThrow("invalid_event_start");
    expect(() => validateFirstEvent({ title: "Show", startsAt: "tomorrow" }, now)).toThrow("invalid_event_start");
    expect(validateFirstEvent({ title: "Show", startsAt: "2026-07-01T19:00:00Z" }, now).startsAt?.toISOString()).toBe("2026-07-01T19:00:00.000Z");
  });
});
