import { DomainError, isBoundedText } from "./index.ts";

export const notificationCategories = ["account", "membership", "event_updates", "results", "moderation", "social", "marketing"] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
export const notificationChannels = ["email", "in_app"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

/** Defaults when no preference row exists. Marketing is opt-in on every channel. */
export function defaultPreference(category: NotificationCategory, _channel: NotificationChannel): boolean {
  return category !== "marketing";
}

export function parseCategory(value: unknown): NotificationCategory {
  if (typeof value !== "string" || !(notificationCategories as readonly string[]).includes(value)) throw new DomainError("invalid_category");
  return value as NotificationCategory;
}

export function parseChannel(value: unknown): NotificationChannel {
  if (value !== "email" && value !== "in_app") throw new DomainError("invalid_channel");
  return value;
}

export interface PreferenceInput { category: NotificationCategory; channel: NotificationChannel; enabled: boolean }

export function parsePreferences(value: unknown): PreferenceInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > notificationCategories.length * 2) throw new DomainError("invalid_preferences");
  return value.map(raw => {
    if (!raw || typeof raw !== "object") throw new DomainError("invalid_preferences");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.enabled !== "boolean") throw new DomainError("invalid_preferences");
    return { category: parseCategory(entry.category), channel: parseChannel(entry.channel), enabled: entry.enabled };
  });
}

export interface NotificationInput {
  category: NotificationCategory;
  title: string;
  body: string;
  link: string | null;
  idempotencyKey: string;
}

export function parseNotificationInput(input: Record<string, unknown>): NotificationInput {
  const category = parseCategory(input.category);
  if (!isBoundedText(input.title, 200, 1)) throw new DomainError("invalid_title");
  const body = input.body ?? "";
  if (!isBoundedText(body, 4000)) throw new DomainError("invalid_body");
  const link = input.link ?? null;
  if (link !== null && (typeof link !== "string" || !/^\/[^/]/.test(link) || link.length > 500 || /[\s\\]/.test(link))) {
    throw new DomainError("invalid_link");
  }
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9:_.-]{1,200}$/.test(input.idempotencyKey)) {
    throw new DomainError("invalid_idempotency_key");
  }
  return { category, title: input.title as string, body: body as string, link: link as string | null, idempotencyKey: input.idempotencyKey };
}

export type ConsentDecision = { allowed: true } | { allowed: false; reason: "not_member" | "feature_disabled" | "preference_off" | "no_email" | "suppressed" };

/** Pure consent evaluation over facts gathered by the storage layer. Fails closed. */
export function evaluateConsent(facts: {
  activeMember: boolean;
  featureEnabled: boolean;
  preference: boolean | null;
  category: NotificationCategory;
  channel: NotificationChannel;
  hasEmail: boolean;
  suppressed: boolean;
}): ConsentDecision {
  if (!facts.activeMember) return { allowed: false, reason: "not_member" };
  if (!facts.featureEnabled) return { allowed: false, reason: "feature_disabled" };
  const enabled = facts.preference ?? defaultPreference(facts.category, facts.channel);
  if (!enabled) return { allowed: false, reason: "preference_off" };
  if (facts.channel === "email") {
    if (!facts.hasEmail) return { allowed: false, reason: "no_email" };
    if (facts.suppressed) return { allowed: false, reason: "suppressed" };
  }
  return { allowed: true };
}
