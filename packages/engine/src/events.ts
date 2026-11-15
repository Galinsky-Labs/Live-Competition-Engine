import { z } from "zod";
import { DomainError } from "./errors.ts";
import { safeParseContestConfig } from "./contest-config.ts";

/** LC-13 event lifecycle. "Event" is a row in `competitions`. */
export const eventStatuses = ["draft", "published", "live", "paused", "completed", "cancelled"] as const;
export type EventStatus = (typeof eventStatuses)[number];

const transitions: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ["published", "cancelled"],
  published: ["draft", "live", "cancelled"],
  live: ["paused", "completed", "cancelled"],
  paused: ["live", "completed", "cancelled"],
  completed: [],
  cancelled: []
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: EventStatus, to: EventStatus): void {
  if (!canTransition(from, to)) throw new DomainError(409, "invalid_transition", `cannot move event from ${from} to ${to}`);
}

export const isPublicStatus = (status: EventStatus) => status === "published" || status === "live" || status === "paused" || status === "completed" || status === "cancelled";
export const isEditableStatus = (status: EventStatus) => status === "draft" || status === "published";

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const venueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).optional(),
  accessibilityNotes: z.string().trim().max(1000).optional()
}).strict();

export const eventInputSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(5000).optional(),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/).optional(),
  timezone: z.string().refine(isValidTimeZone, "unknown time zone").default("UTC"),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  venue: venueSchema.nullable().optional(),
  remote: z.boolean().default(false)
}).strict().refine(e => !e.startsAt || !e.endsAt || Date.parse(e.endsAt) > Date.parse(e.startsAt), { message: "endsAt must be after startsAt", path: ["endsAt"] });

export type EventInput = z.infer<typeof eventInputSchema>;
export const eventPatchSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  timezone: z.string().refine(isValidTimeZone, "unknown time zone").optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  venue: venueSchema.nullable().optional(),
  remote: z.boolean().optional()
}).strict();
export type EventPatch = z.infer<typeof eventPatchSchema>;

export interface PublishableEvent {
  title: string;
  startsAt: Date | null;
  endsAt: Date | null;
  venue: unknown;
  remote: boolean;
  config: unknown;
}

/** Returns the reasons an event cannot be published (empty when it can). */
export function publishBlockers(event: PublishableEvent): string[] {
  const reasons: string[] = [];
  if (!event.startsAt) reasons.push("startsAt is required");
  if (event.startsAt && event.endsAt && event.endsAt <= event.startsAt) reasons.push("endsAt must be after startsAt");
  if (!event.venue && !event.remote) reasons.push("a venue or remote stream is required");
  const config = safeParseContestConfig(event.config);
  if (!config.ok) reasons.push(...config.issues);
  return reasons;
}
