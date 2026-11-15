import { DomainError, isBoundedText } from "./index.ts";

/**
 * LC-49 pure SaaS plan logic: plan validation, plan-change classification,
 * proration, limit evaluation and subscription state transitions. No I/O.
 */
export const PLAN_LIMIT_KEYS = [
  "max_events_per_month",
  "max_storage_bytes",
  "max_members",
  "max_custom_domains"
] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
/** null = unlimited. A missing key is treated as 0 (fail closed). */
export type PlanLimits = Partial<Record<PlanLimitKey, number | null>>;

export type BillingInterval = "month" | "year";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";

export interface PlanDefinitionInput {
  planKey: string;
  name: string;
  currency: string;
  billingInterval: BillingInterval;
  priceMinor: number;
  trialDays: number;
  features: string[];
  limits: PlanLimits;
}

const MAX_PRICE_MINOR = 100_000_000_000;
const MAX_LIMIT = 1_000_000_000_000_000;

export function isPlanLimitKey(value: unknown): value is PlanLimitKey {
  return typeof value === "string" && (PLAN_LIMIT_KEYS as readonly string[]).includes(value);
}

/**
 * Validate and normalize a plan definition. `isFeatureKey` is injected so the
 * caller can bind it to the LC-08 feature registry.
 */
export function validatePlanDefinition(input: unknown, isFeatureKey: (value: string) => boolean): PlanDefinitionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("invalid_plan");
  const v = input as Record<string, unknown>;
  const fail = (field: string): never => { throw new DomainError("invalid_plan", `invalid_plan: ${field}`); };
  if (typeof v.planKey !== "string" || !/^[a-z][a-z0-9_-]{1,39}$/.test(v.planKey)) fail("planKey");
  if (!isBoundedText(v.name, 120, 1) || (v.name as string).trim() === "") fail("name");
  if (typeof v.currency !== "string" || !/^[A-Z]{3}$/.test(v.currency)) fail("currency");
  if (v.billingInterval !== "month" && v.billingInterval !== "year") fail("billingInterval");
  if (!Number.isSafeInteger(v.priceMinor) || (v.priceMinor as number) < 0 || (v.priceMinor as number) > MAX_PRICE_MINOR) fail("priceMinor");
  const trialDays = v.trialDays ?? 0;
  if (!Number.isSafeInteger(trialDays) || (trialDays as number) < 0 || (trialDays as number) > 90) fail("trialDays");
  if (!Array.isArray(v.features) || v.features.length > 64) fail("features");
  const features = [...new Set(v.features as unknown[])];
  if (features.some(f => typeof f !== "string" || !isFeatureKey(f))) fail("features");
  if (!v.limits || typeof v.limits !== "object" || Array.isArray(v.limits)) fail("limits");
  const limits: PlanLimits = {};
  for (const [key, value] of Object.entries(v.limits as Record<string, unknown>)) {
    if (!isPlanLimitKey(key)) fail(`limits.${key}`);
    if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_LIMIT)) fail(`limits.${key}`);
    limits[key as PlanLimitKey] = value as number | null;
  }
  for (const key of PLAN_LIMIT_KEYS) if (!(key in limits)) fail(`limits.${key}`);
  return {
    planKey: v.planKey as string,
    name: (v.name as string).trim(),
    currency: v.currency as string,
    billingInterval: v.billingInterval as BillingInterval,
    priceMinor: v.priceMinor as number,
    trialDays: trialDays as number,
    features: (features as string[]).sort(),
    limits
  };
}

export interface PlanTerms {
  currency: string;
  billingInterval: BillingInterval;
  priceMinor: number;
  limits: PlanLimits;
}

export type PlanChangeKind = "upgrade" | "downgrade" | "lateral";

/** Upgrades (price increase, or equal price) apply now; price decreases are downgrades applied at period end. */
export function classifyPlanChange(from: PlanTerms, to: PlanTerms): PlanChangeKind {
  if (from.currency !== to.currency) throw new DomainError("plan_change_currency_mismatch");
  if (from.billingInterval !== to.billingInterval) throw new DomainError("plan_change_interval_mismatch");
  if (to.priceMinor > from.priceMinor) return "upgrade";
  if (to.priceMinor < from.priceMinor) return "downgrade";
  return "lateral";
}

export interface ProrationInput {
  fromPriceMinor: number;
  toPriceMinor: number;
  periodStart: Date;
  periodEnd: Date;
  changeAt: Date;
}

export interface Proration {
  /** Unused value of the current plan for the rest of the period (credited). */
  creditMinor: number;
  /** Value of the new plan for the rest of the period (charged). */
  chargeMinor: number;
  /** charge - credit; positive means the tenant owes this amount now. */
  netMinor: number;
  remainingMs: number;
  periodMs: number;
}

/** Exact integer proration (BigInt), rounding half up per component. */
export function computeProration(input: ProrationInput): Proration {
  const { fromPriceMinor, toPriceMinor } = input;
  for (const price of [fromPriceMinor, toPriceMinor]) {
    if (!Number.isSafeInteger(price) || price < 0) throw new DomainError("invalid_proration");
  }
  const start = input.periodStart.getTime();
  const end = input.periodEnd.getTime();
  const at = input.changeAt.getTime();
  if (![start, end, at].every(Number.isFinite) || end <= start) throw new DomainError("invalid_proration");
  const clampedAt = Math.min(Math.max(at, start), end);
  const periodMs = end - start;
  const remainingMs = end - clampedAt;
  const share = (price: number) => {
    const numerator = BigInt(price) * BigInt(remainingMs);
    const denominator = BigInt(periodMs);
    return Number((numerator * 2n + denominator) / (denominator * 2n));
  };
  const creditMinor = share(fromPriceMinor);
  const chargeMinor = share(toPriceMinor);
  return { creditMinor, chargeMinor, netMinor: chargeMinor - creditMinor, remainingMs, periodMs };
}

export type PlanUsage = Partial<Record<PlanLimitKey, number>>;

export interface LimitViolation {
  limitKey: PlanLimitKey;
  limit: number;
  current: number;
}

/** Limits that current usage already exceeds under `limits`. Missing limit = 0. */
export function limitViolations(usage: PlanUsage, limits: PlanLimits): LimitViolation[] {
  const violations: LimitViolation[] = [];
  for (const key of PLAN_LIMIT_KEYS) {
    const limit = key in limits ? limits[key]! : 0;
    const current = usage[key] ?? 0;
    if (limit !== null && current > limit) violations.push({ limitKey: key, limit, current });
  }
  return violations;
}

export interface LimitDecision {
  allowed: boolean;
  limit: number | null;
  current: number;
  requested: number;
  remaining: number | null;
}

export function evaluateLimit(limits: PlanLimits, key: PlanLimitKey, current: number, increment: number): LimitDecision {
  if (!Number.isSafeInteger(increment) || increment < 0) throw new DomainError("invalid_limit_increment");
  const limit = key in limits ? limits[key]! : 0;
  if (limit === null) return { allowed: true, limit, current, requested: increment, remaining: null };
  return {
    allowed: current + increment <= limit,
    limit,
    current,
    requested: increment,
    remaining: Math.max(limit - current, 0)
  };
}

const transitions: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  trialing: ["active", "past_due", "cancelled"],
  active: ["past_due", "cancelled"],
  past_due: ["active", "cancelled"],
  cancelled: []
};

export function canTransitionSubscription(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return transitions[from].includes(to);
}

export function assertSubscriptionTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (!canTransitionSubscription(from, to)) throw new DomainError("invalid_state_subscription_transition");
}

/** Add one billing interval in UTC, clamping to the last day of shorter months. */
export function addInterval(start: Date, interval: BillingInterval, count = 1): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const targetMonth = interval === "month" ? m + count : m + 12 * count;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const day = Math.min(start.getUTCDate(), lastDay);
  return new Date(Date.UTC(targetYear, normalizedMonth, day, start.getUTCHours(), start.getUTCMinutes(),
    start.getUTCSeconds(), start.getUTCMilliseconds()));
}

/** First instant of the UTC calendar month containing `at` (usage aggregation period). */
export function usagePeriodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function parseUsagePeriod(value: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new DomainError("invalid_usage_period");
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new DomainError("invalid_usage_period");
  return new Date(Date.UTC(Number(match[1]), month - 1, 1));
}

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  planPriceMinor: number;
  billingInterval: BillingInterval;
  trialEndsAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  pendingPlan: { id: string; priceMinor: number } | null;
}

export type SubscriptionStep =
  | { kind: "trial_ended"; toStatus: "active"; periodStart: Date; periodEnd: Date; chargeMinor: number }
  | { kind: "downgrade_applied"; planId: string; periodStart: Date; periodEnd: Date; chargeMinor: number }
  | { kind: "renewed"; periodStart: Date; periodEnd: Date; chargeMinor: number };

/**
 * Next due lifecycle step at `now`, or null. Trial end starts the first paid period
 * (the charge is exposed for LC-51 billing; collection failure is reported back as past_due).
 */
export function nextSubscriptionStep(s: SubscriptionSnapshot, now: Date): SubscriptionStep | null {
  if (s.status === "cancelled") return null;
  if (s.status === "trialing") {
    if (!s.trialEndsAt || s.trialEndsAt.getTime() > now.getTime()) return null;
    const periodStart = s.trialEndsAt;
    const price = s.pendingPlan?.priceMinor ?? s.planPriceMinor;
    return { kind: "trial_ended", toStatus: "active", periodStart, periodEnd: addInterval(periodStart, s.billingInterval), chargeMinor: price };
  }
  if (s.currentPeriodEnd.getTime() > now.getTime()) return null;
  const periodStart = s.currentPeriodEnd;
  const periodEnd = addInterval(periodStart, s.billingInterval);
  if (s.pendingPlan) {
    return { kind: "downgrade_applied", planId: s.pendingPlan.id, periodStart, periodEnd, chargeMinor: s.pendingPlan.priceMinor };
  }
  return { kind: "renewed", periodStart, periodEnd, chargeMinor: s.planPriceMinor };
}
