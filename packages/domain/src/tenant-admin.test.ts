import { describe, expect, it } from "vitest";
import {
  assertMembershipTransition,
  invitationExpiry,
  normalizeEmail,
  parseInvitationRole,
  parseRoleGrantRequest,
  parseVenueInput
} from "./tenant-admin";

const competitionId = "11111111-1111-4111-8111-111111111111";

describe("tenant administration rules", () => {
  it("normalizes emails and rejects malformed ones", () => {
    expect(normalizeEmail("  Person@Example.ORG ")).toBe("person@example.org");
    for (const bad of ["", "no-at", "a@b", "a b@c.de", 5]) expect(() => normalizeEmail(bad)).toThrow();
  });

  it("never allows platform_operator and enforces competition scope", () => {
    expect(() => parseRoleGrantRequest({ role: "platform_operator" })).toThrow("role_not_grantable");
    expect(() => parseRoleGrantRequest({ role: "superuser" })).toThrow("role_not_grantable");
    expect(parseRoleGrantRequest({ role: "viewer" })).toEqual({ role: "viewer", competitionId: null });
    expect(() => parseRoleGrantRequest({ role: "viewer", competitionId })).toThrow("invalid_competition_scope");
    expect(() => parseRoleGrantRequest({ role: "judge" })).toThrow("invalid_competition_scope");
    expect(parseRoleGrantRequest({ role: "judge", competitionId })).toEqual({ role: "judge", competitionId });
  });

  it("restricts invitation roles to tenant-wide roles", () => {
    expect(parseInvitationRole(undefined)).toBeNull();
    expect(parseInvitationRole("industry_scout")).toBe("industry_scout");
    expect(() => parseInvitationRole("judge")).toThrow("role_not_grantable");
    expect(() => parseInvitationRole("platform_operator")).toThrow("role_not_grantable");
  });

  it("bounds invitation lifetime", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(invitationExpiry(now).toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(() => invitationExpiry(now, 10)).toThrow("invalid_invitation_ttl");
    expect(() => invitationExpiry(now, 365 * 24 * 3600 * 1000)).toThrow("invalid_invitation_ttl");
  });

  it("validates venues", () => {
    expect(parseVenueInput({ name: " Hall ", capacity: 300, timezone: "America/New_York" }))
      .toEqual({ name: "Hall", address: null, capacity: 300, timezone: "America/New_York" });
    expect(() => parseVenueInput({ name: "" })).toThrow("invalid_venue_name");
    expect(() => parseVenueInput({ name: "Hall", capacity: 0 })).toThrow("invalid_venue_capacity");
    expect(() => parseVenueInput({ name: "Hall", timezone: "../etc" })).toThrow("invalid_venue_timezone");
  });

  it("rejects no-op membership transitions", () => {
    expect(() => assertMembershipTransition("active", "active")).toThrow();
    expect(() => assertMembershipTransition("active", "suspended")).not.toThrow();
  });
});
