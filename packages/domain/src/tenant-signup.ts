import { DomainError, isBoundedText } from "./index.ts";

/** LC-50 pure signup validation and onboarding checklist computation. No I/O. */

/** Slugs that collide with platform routes, infrastructure names or trust-sensitive words. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "about", "abuse", "account", "accounts", "admin", "administrator", "api", "app", "apps", "assets", "auth",
  "billing", "blog", "cdn", "dashboard", "dev", "docs", "email", "engine", "help", "internal", "legal", "login",
  "logout", "mail", "new", "null", "official", "onboarding", "organizations", "platform", "postmaster", "privacy",
  "public", "root", "security", "settings", "signup", "staff", "static", "status", "support", "system",
  "terms", "test", "undefined", "verify", "webhooks", "www"
]);

export const SIGNUP_RATE_LIMIT = { maxAttempts: 5, windowMs: 60 * 60 * 1000 } as const;
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const VERIFICATION_RESEND_LIMIT = { maxTokens: 5, windowMs: 60 * 60 * 1000 } as const;

export function normalizeEmail(input: unknown): string {
  if (typeof input !== "string") throw new DomainError("invalid_email");
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) {
    throw new DomainError("invalid_email");
  }
  if (/[\u0000-\u001f\u007f]/.test(email)) throw new DomainError("invalid_email");
  return email;
}

export type SlugCheck = { ok: true; slug: string } | { ok: false; reason: "invalid_slug" | "slug_reserved" };

export function checkSlug(input: unknown): SlugCheck {
  if (typeof input !== "string") return { ok: false, reason: "invalid_slug" };
  const slug = input.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) || slug.includes("--")) return { ok: false, reason: "invalid_slug" };
  // fx- is reserved for test fixtures; xn-- (punycode) is excluded by the "--" rule.
  if (RESERVED_SLUGS.has(slug) || slug.startsWith("fx-")) return { ok: false, reason: "slug_reserved" };
  return { ok: true, slug };
}

export function normalizeSlug(input: unknown): string {
  const result = checkSlug(input);
  if (!result.ok) throw new DomainError(result.reason);
  return result.slug;
}

export function normalizeOrganizationName(input: unknown): string {
  if (!isBoundedText(input, 120, 1)) throw new DomainError("invalid_organization_name");
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length < 2) throw new DomainError("invalid_organization_name");
  return name;
}

export interface SignupInput {
  email: string;
  organizationName: string;
  slug: string;
  planKey: string | null;
}

export function validateSignup(input: unknown): SignupInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("invalid_signup");
  const v = input as Record<string, unknown>;
  const planKey = v.planKey ?? null;
  if (planKey !== null && (typeof planKey !== "string" || !/^[a-z][a-z0-9_-]{1,39}$/.test(planKey))) {
    throw new DomainError("invalid_plan_key");
  }
  return {
    email: normalizeEmail(v.email),
    organizationName: normalizeOrganizationName(v.organizationName),
    slug: normalizeSlug(v.slug),
    planKey: planKey as string | null
  };
}

export const ONBOARDING_STEPS = [
  "email_verified",
  "branding_set",
  "custom_domain_claimed",
  "members_invited",
  "payment_setup",
  "first_event_created"
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const SKIPPABLE_STEPS: readonly OnboardingStep[] = ["branding_set", "custom_domain_claimed", "members_invited", "payment_setup"];
export type StepStatus = "complete" | "pending" | "skipped" | "external_pending";

export interface OnboardingFacts {
  emailVerified: boolean;
  hasActiveTheme: boolean;
  domainClaims: number;
  activeMembers: number;
  /** Payment setup belongs to LC-51; until it reports, the step is external_pending. */
  paymentSetupComplete: boolean | null;
  firstEventId: string | null;
  eventCount: number;
  skippedSteps: readonly string[];
}

export interface OnboardingChecklist {
  steps: { key: OnboardingStep; status: StepStatus; required: boolean }[];
  completed: number;
  total: number;
  /** All required steps complete; optional ones complete or skipped. */
  ready: boolean;
}

export function computeOnboardingChecklist(f: OnboardingFacts): OnboardingChecklist {
  const done: Record<OnboardingStep, boolean> = {
    email_verified: f.emailVerified,
    branding_set: f.hasActiveTheme,
    custom_domain_claimed: f.domainClaims > 0,
    members_invited: f.activeMembers > 1,
    payment_setup: f.paymentSetupComplete === true,
    first_event_created: f.firstEventId !== null || f.eventCount > 0
  };
  const steps = ONBOARDING_STEPS.map(key => {
    const required = !SKIPPABLE_STEPS.includes(key);
    let status: StepStatus = done[key] ? "complete" : "pending";
    if (status === "pending" && !required && f.skippedSteps.includes(key)) status = "skipped";
    if (status === "pending" && key === "payment_setup" && f.paymentSetupComplete === null) status = "external_pending";
    return { key, status, required };
  });
  const completed = steps.filter(s => s.status === "complete").length;
  const ready = steps.every(s => s.status === "complete" || (!s.required && s.status !== "pending"));
  return { steps, completed, total: steps.length, ready };
}

export interface FirstEventInput {
  title: string;
  description: string | null;
  startsAt: Date | null;
}

export function validateFirstEvent(input: unknown, now: Date): FirstEventInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("invalid_event");
  const v = input as Record<string, unknown>;
  if (!isBoundedText(v.title, 160, 1) || v.title.trim().length < 2) throw new DomainError("invalid_event_title");
  const description = v.description ?? null;
  if (description !== null && !isBoundedText(description, 4000)) throw new DomainError("invalid_event_description");
  let startsAt: Date | null = null;
  if (v.startsAt !== undefined && v.startsAt !== null) {
    if (typeof v.startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v.startsAt)) throw new DomainError("invalid_event_start");
    startsAt = new Date(v.startsAt);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < now.getTime() - 60_000 ||
        startsAt.getTime() > now.getTime() + 5 * 365 * 86_400_000) throw new DomainError("invalid_event_start");
  }
  return { title: v.title.trim(), description: description as string | null, startsAt };
}
