import { describe, expect, it } from "vitest";
import {
  DELETION_GRACE_MS,
  planLifecycleTransition,
  tenantAccessError,
  validateAnnouncement,
  validateFraudFlag,
  validateNoteBody,
  validateReason
} from "./platform-admin";

const now = new Date("2026-06-01T00:00:00Z");
const id = "11111111-1111-4111-8111-111111111111";

describe("tenant lifecycle", () => {
  it("allows only explicit transitions and marks destructive ones", () => {
    expect(planLifecycleTransition("active", "suspend", now, null)).toEqual({ from: "active", to: "suspended", deletionScheduledFor: null, requiresStepUp: true });
    expect(planLifecycleTransition("suspended", "reactivate", now, null).requiresStepUp).toBe(false);
    expect(() => planLifecycleTransition("active", "reactivate", now, null)).toThrow("invalid_state_tenant_transition");
    expect(() => planLifecycleTransition("deleted", "reactivate", now, null)).toThrow("invalid_state_tenant_transition");
    expect(() => planLifecycleTransition("suspended", "suspend", now, null)).toThrow("invalid_state_tenant_transition");
  });

  it("schedules deletion with a 30-day grace and enforces it", () => {
    const scheduled = planLifecycleTransition("suspended", "schedule_deletion", now, null);
    expect(scheduled.deletionScheduledFor?.getTime()).toBe(now.getTime() + DELETION_GRACE_MS);
    expect(() => planLifecycleTransition("scheduled_deletion", "finalize_deletion", now, scheduled.deletionScheduledFor)).toThrow("invalid_state_deletion_grace_period");
    const later = new Date(now.getTime() + DELETION_GRACE_MS);
    expect(planLifecycleTransition("scheduled_deletion", "finalize_deletion", later, scheduled.deletionScheduledFor).to).toBe("deleted");
    expect(planLifecycleTransition("scheduled_deletion", "cancel_deletion", now, scheduled.deletionScheduledFor)).toMatchObject({ to: "suspended", deletionScheduledFor: null, requiresStepUp: false });
  });

  it("maps statuses to access errors", () => {
    expect(tenantAccessError("active")).toBeNull();
    expect(tenantAccessError("suspended")).toBe("tenant_suspended");
    expect(tenantAccessError("scheduled_deletion")).toBe("tenant_scheduled_for_deletion");
    expect(tenantAccessError("deleted")).toBe("tenant_deleted");
  });
});

describe("validation", () => {
  it("validates reasons, notes and fraud flags", () => {
    expect(validateReason("  chargebacks  ")).toBe("chargebacks");
    expect(() => validateReason("x")).toThrow("invalid_reason");
    expect(() => validateNoteBody("")).toThrow("invalid_note");
    expect(validateFraudFlag({ subjectType: "account", subjectId: id, severity: "high", reason: "card testing" }).severity).toBe("high");
    expect(() => validateFraudFlag({ subjectType: "event", subjectId: id, severity: "high", reason: "abc" })).toThrow("invalid_fraud_flag");
    expect(() => validateFraudFlag({ subjectType: "account", subjectId: id, severity: "extreme", reason: "abc" })).toThrow("invalid_fraud_flag");
  });

  it("validates announcements and dedupes targets", () => {
    expect(validateAnnouncement({ title: "v2", body: "Notes", targetOrganizationIds: [id, id.toUpperCase()] }))
      .toEqual({ title: "v2", body: "Notes", severity: "info", targetOrganizationIds: [id] });
    expect(() => validateAnnouncement({ title: "", body: "x" })).toThrow("invalid_announcement");
    expect(() => validateAnnouncement({ title: "t", body: "x", targetOrganizationIds: [] })).toThrow("invalid_announcement");
    expect(() => validateAnnouncement({ title: "t", body: "x", severity: "loud" })).toThrow("invalid_announcement");
  });
});
