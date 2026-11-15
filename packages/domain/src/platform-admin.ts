import { DomainError, isBoundedText, isUuid } from "./index.ts";

/** LC-53 pure platform-admin rules: tenant lifecycle, step-up policy, input validation. No I/O. */

export const TENANT_STATUSES = ["active", "suspended", "scheduled_deletion", "deleted"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const LIFECYCLE_ACTIONS = ["suspend", "reactivate", "schedule_deletion", "cancel_deletion", "finalize_deletion"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** Actions that remove access or data require a valid step-up grant. */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<LifecycleAction> = new Set(["suspend", "schedule_deletion", "finalize_deletion"]);

export const DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const STEP_UP_TTL_MS = 10 * 60 * 1000;
/** A session younger than this counts as a fresh re-authentication for step-up. */
export const FRESH_SESSION_MS = 5 * 60 * 1000;

const transitions: Readonly<Record<LifecycleAction, { from: readonly TenantStatus[]; to: TenantStatus }>> = {
  suspend: { from: ["active"], to: "suspended" },
  reactivate: { from: ["suspended"], to: "active" },
  schedule_deletion: { from: ["active", "suspended"], to: "scheduled_deletion" },
  // Cancelling a deletion leaves the tenant suspended; reactivation is a separate, explicit decision.
  cancel_deletion: { from: ["scheduled_deletion"], to: "suspended" },
  finalize_deletion: { from: ["scheduled_deletion"], to: "deleted" }
};

export function isLifecycleAction(value: unknown): value is LifecycleAction {
  return typeof value === "string" && (LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}

export interface LifecyclePlan {
  from: TenantStatus;
  to: TenantStatus;
  deletionScheduledFor: Date | null;
  requiresStepUp: boolean;
}

export function planLifecycleTransition(
  current: TenantStatus,
  action: LifecycleAction,
  now: Date,
  deletionScheduledFor: Date | null
): LifecyclePlan {
  const rule = transitions[action];
  if (!rule.from.includes(current)) throw new DomainError("invalid_state_tenant_transition");
  if (action === "finalize_deletion" && (!deletionScheduledFor || deletionScheduledFor.getTime() > now.getTime())) {
    throw new DomainError("invalid_state_deletion_grace_period");
  }
  return {
    from: current,
    to: rule.to,
    deletionScheduledFor: action === "schedule_deletion" ? new Date(now.getTime() + DELETION_GRACE_MS)
      : action === "finalize_deletion" ? deletionScheduledFor : null,
    requiresStepUp: DESTRUCTIVE_ACTIONS.has(action)
  };
}

/** Error code a tenant API returns for a non-active tenant, or null when active. */
export function tenantAccessError(status: TenantStatus): string | null {
  switch (status) {
    case "active": return null;
    case "suspended": return "tenant_suspended";
    case "scheduled_deletion": return "tenant_scheduled_for_deletion";
    case "deleted": return "tenant_deleted";
  }
}

export function validateReason(value: unknown, max = 1000): string {
  if (!isBoundedText(value, max, 3) || value.trim().length < 3) throw new DomainError("invalid_reason");
  return value.trim();
}

export const FRAUD_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type FraudSeverity = (typeof FRAUD_SEVERITIES)[number];

export interface FraudFlagInput {
  subjectType: "organization" | "account";
  subjectId: string;
  severity: FraudSeverity;
  reason: string;
}

export function validateFraudFlag(input: unknown): FraudFlagInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("invalid_fraud_flag");
  const v = input as Record<string, unknown>;
  if (v.subjectType !== "organization" && v.subjectType !== "account") throw new DomainError("invalid_fraud_flag");
  if (!isUuid(v.subjectId)) throw new DomainError("invalid_fraud_flag");
  if (!(FRAUD_SEVERITIES as readonly unknown[]).includes(v.severity)) throw new DomainError("invalid_fraud_flag");
  return { subjectType: v.subjectType, subjectId: v.subjectId, severity: v.severity as FraudSeverity, reason: validateReason(v.reason, 2000) };
}

export function validateNoteBody(value: unknown): string {
  if (!isBoundedText(value, 4000, 1) || value.trim() === "") throw new DomainError("invalid_note");
  return value.trim();
}

export interface AnnouncementInput {
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  targetOrganizationIds: string[] | null;
}

export function validateAnnouncement(input: unknown): AnnouncementInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("invalid_announcement");
  const v = input as Record<string, unknown>;
  if (!isBoundedText(v.title, 200, 1) || v.title.trim() === "") throw new DomainError("invalid_announcement");
  if (!isBoundedText(v.body, 20000, 1) || v.body.trim() === "") throw new DomainError("invalid_announcement");
  const severity = v.severity ?? "info";
  if (severity !== "info" && severity !== "warning" && severity !== "critical") throw new DomainError("invalid_announcement");
  let targets: string[] | null = null;
  if (v.targetOrganizationIds !== undefined && v.targetOrganizationIds !== null) {
    if (!Array.isArray(v.targetOrganizationIds) || v.targetOrganizationIds.length < 1 || v.targetOrganizationIds.length > 500 ||
        !v.targetOrganizationIds.every(isUuid)) throw new DomainError("invalid_announcement");
    targets = [...new Set(v.targetOrganizationIds.map(id => id.toLowerCase()))];
  }
  return { title: v.title.trim(), body: v.body.trim(), severity, targetOrganizationIds: targets };
}
