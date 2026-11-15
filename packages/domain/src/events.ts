import { DomainError, isBoundedText } from "./index.ts";

/**
 * LC-13 event (competition) lifecycle and field validation. Pure; no I/O.
 *
 *   draft ──publish──▶ published ──start──▶ live ⇄ paused
 *     │                   │                  │       │
 *     └──cancel──┐        ├──complete──┐     └──complete / cancel
 *                ▼        ▼            ▼
 *            cancelled ◀──┘        completed        (terminal states)
 */
export const EVENT_STATUSES = ["draft", "published", "live", "paused", "completed", "cancelled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export type EventVisibility = "public" | "members" | "private";

export const EVENT_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ["published", "cancelled"],
  published: ["live", "completed", "cancelled"],
  live: ["paused", "completed", "cancelled"],
  paused: ["live", "completed", "cancelled"],
  completed: [],
  cancelled: []
};

export function isEventStatus(value: unknown): value is EventStatus {
  return typeof value === "string" && (EVENT_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return EVENT_TRANSITIONS[from].includes(to);
}

export interface EventFields {
  title: string;
  description: string | null;
  slug: string | null;
  timezone: string;
  capacity: number | null;
  venueName: string | null;
  venueAddress: string | null;
  streamUrl: string | null;
  visibility: EventVisibility;
  startsAt: Date | null;
  endsAt: Date | null;
}

export type EventPatch = Partial<EventFields>;

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** IANA time zone check using the runtime's tz database ("UTC" always accepted). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  if (value === "UTC") return true;
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function parseStreamUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DomainError("invalid_stream_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || value.length > 2048) {
    throw new DomainError("invalid_stream_url");
  }
  return url.toString();
}

function parseDate(value: unknown, code: string): Date | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40) throw new DomainError(code);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new DomainError(code);
  return date;
}

function optionalText(value: unknown, max: number, code: string): string | null {
  if (value === null) return null;
  if (!isBoundedText(value, max, 1) || !value.trim()) throw new DomainError(code);
  return value;
}

const FIELD_PARSERS: { [K in keyof EventFields]: (value: unknown) => EventFields[K] } = {
  title: value => {
    if (!isBoundedText(value, 200, 1) || !value.trim()) throw new DomainError("invalid_title");
    return value;
  },
  description: value => (value === null ? null : (() => {
    if (!isBoundedText(value, 5000)) throw new DomainError("invalid_description");
    return value;
  })()),
  slug: value => {
    if (value === null) return null;
    if (typeof value !== "string" || !SLUG_PATTERN.test(value)) throw new DomainError("invalid_slug");
    return value;
  },
  timezone: value => {
    if (!isValidTimeZone(value)) throw new DomainError("invalid_timezone");
    return value;
  },
  capacity: value => {
    if (value === null) return null;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) throw new DomainError("invalid_capacity");
    return value as number;
  },
  venueName: value => optionalText(value, 200, "invalid_venue"),
  venueAddress: value => optionalText(value, 500, "invalid_venue"),
  streamUrl: value => {
    if (value === null) return null;
    if (typeof value !== "string") throw new DomainError("invalid_stream_url");
    return parseStreamUrl(value);
  },
  visibility: value => {
    if (value !== "public" && value !== "members" && value !== "private") throw new DomainError("invalid_visibility");
    return value;
  },
  startsAt: value => parseDate(value, "invalid_starts_at"),
  endsAt: value => parseDate(value, "invalid_ends_at")
};

/** Parse an untrusted JSON object into a validated patch; unknown keys are rejected. */
export function parseEventPatch(body: Record<string, unknown>): EventPatch {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const parser = FIELD_PARSERS[key as keyof EventFields];
    if (!parser) throw new DomainError("invalid_event_field");
    patch[key] = parser(value);
  }
  return patch as EventPatch;
}

export const EVENT_DEFAULTS: Omit<EventFields, "title"> = {
  description: null, slug: null, timezone: "UTC", capacity: null, venueName: null, venueAddress: null,
  streamUrl: null, visibility: "private", startsAt: null, endsAt: null
};

/** Parse a create body: title required, everything else defaults. */
export function parseEventCreate(body: Record<string, unknown>): EventFields {
  const patch = parseEventPatch(body);
  if (patch.title === undefined) throw new DomainError("invalid_title");
  const fields = { ...EVENT_DEFAULTS, ...patch } as EventFields;
  assertConsistent(fields);
  return fields;
}

/** Cross-field invariants that hold in every state. */
export function assertConsistent(fields: EventFields): void {
  if (fields.startsAt && fields.endsAt && fields.endsAt.getTime() <= fields.startsAt.getTime()) {
    throw new DomainError("invalid_schedule");
  }
  if (fields.venueAddress && !fields.venueName) throw new DomainError("invalid_venue");
}

/** Apply a patch to the current fields under the lifecycle's edit rules. */
export function applyEventPatch(status: EventStatus, current: EventFields, patch: EventPatch): EventFields {
  if (status === "completed" || status === "cancelled") throw new DomainError("invalid_state_event_closed");
  if (status !== "draft" && patch.slug !== undefined && patch.slug !== current.slug) {
    // Public URLs must stay stable after publication.
    throw new DomainError("invalid_state_slug_locked");
  }
  const next = { ...current, ...patch };
  assertConsistent(next);
  if (status !== "draft") assertPublishable(next);
  return next;
}

/** Preconditions for publication (and for edits once published). */
export function assertPublishable(fields: EventFields): void {
  if (!fields.slug) throw new DomainError("event_not_publishable_slug_required");
  if (!fields.startsAt) throw new DomainError("event_not_publishable_start_required");
  if (!fields.venueName && !fields.streamUrl) throw new DomainError("event_not_publishable_location_required");
}

/** Validate a lifecycle transition; cancellation requires a bounded reason. */
export function planTransition(
  from: EventStatus,
  to: EventStatus,
  fields: EventFields,
  reason: string | null
): { reason: string | null } {
  if (!canTransition(from, to)) throw new DomainError("invalid_state_transition");
  if (to === "cancelled") {
    if (!isBoundedText(reason, 1000, 1) || !reason.trim()) throw new DomainError("cancel_reason_required");
    return { reason };
  }
  if (reason !== null && !isBoundedText(reason, 1000)) throw new DomainError("invalid_reason");
  if (to === "published") assertPublishable(fields);
  return { reason };
}
