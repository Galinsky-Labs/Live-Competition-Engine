import { DomainError, isBoundedText, isUuid } from "./index.ts";
import { normalizeCurrency, requireMinorAmount } from "./money.ts";

export const subscriptionStatuses = ["incomplete", "active", "past_due", "cancelled", "expired"] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

const transitions: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  incomplete: ["active", "expired", "cancelled"],
  active: ["active", "past_due", "cancelled", "expired"],
  past_due: ["active", "cancelled", "expired"],
  cancelled: [],
  expired: []
};

export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function assertSubscriptionTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!canTransitionSubscription(from, to)) throw new DomainError("invalid_state_transition");
}

/** Status after the provider ends a subscription: a lapse in payment expires, otherwise it is a cancellation. */
export function endedStatus(current: SubscriptionStatus): SubscriptionStatus {
  return current === "incomplete" || current === "past_due" ? "expired" : "cancelled";
}

export type CreatorType = "tenant" | "participant" | "account";

export interface PlanInput {
  creatorType: CreatorType;
  creatorId: string | null;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  interval: "month" | "year";
  termsVersion: string;
}

export function validatePlanInput(body: Record<string, unknown>): PlanInput {
  const creatorType = body.creatorType ?? "tenant";
  if (creatorType !== "tenant" && creatorType !== "participant" && creatorType !== "account") throw new DomainError("invalid_creator");
  const creatorId = body.creatorId ?? null;
  if (creatorType === "tenant" ? creatorId !== null : !isUuid(creatorId)) throw new DomainError("invalid_creator");
  if (!isBoundedText(body.name, 120, 1) || !body.name.trim()) throw new DomainError("invalid_name");
  const description = body.description ?? "";
  if (!isBoundedText(description, 2000)) throw new DomainError("invalid_description");
  const interval = body.interval;
  if (interval !== "month" && interval !== "year") throw new DomainError("invalid_interval");
  if (typeof body.termsVersion !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(body.termsVersion)) throw new DomainError("invalid_terms_version");
  return {
    creatorType, creatorId: creatorId as string | null, name: body.name.trim(), description,
    priceMinor: requireMinorAmount(body.priceMinor, { allowZero: false }), currency: normalizeCurrency(body.currency),
    interval, termsVersion: body.termsVersion
  };
}

/**
 * Recurring billing requires explicit, informed consent: the subscriber must
 * accept the exact terms version, price, currency and interval on offer.
 */
export function validateConsent(
  consent: unknown,
  plan: { termsVersion: string; priceMinor: number; currency: string; interval: string }
): { termsVersion: string } {
  const c = consent as { accepted?: unknown; termsVersion?: unknown; priceMinor?: unknown; currency?: unknown; interval?: unknown } | null;
  if (!c || c.accepted !== true) throw new DomainError("consent_required");
  if (c.termsVersion !== plan.termsVersion) throw new DomainError("consent_terms_conflict");
  if (c.priceMinor !== plan.priceMinor || typeof c.currency !== "string" || c.currency.toUpperCase() !== plan.currency || c.interval !== plan.interval) {
    throw new DomainError("consent_price_conflict");
  }
  return { termsVersion: plan.termsVersion };
}
