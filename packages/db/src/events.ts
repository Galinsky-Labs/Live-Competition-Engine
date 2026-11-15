import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  applyEventPatch,
  planTransition,
  SLUG_PATTERN,
  type EventFields,
  type EventPatch,
  type EventStatus,
  type EventVisibility
} from "@live-competition-engine/domain/events";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/** LC-13 events: competitions with lifecycle, revisioned edits, audit and public projections. */
export interface EventRecord extends EventFields {
  id: string;
  organizationId: string;
  status: EventStatus;
  revision: number;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Public projection: no internal ids beyond the event id, no actor data. */
export interface PublicEvent {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: EventStatus;
  timezone: string;
  capacity: number | null;
  venueName: string | null;
  venueAddress: string | null;
  streamUrl: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

interface EventRow {
  id: string; organization_id: string; title: string; description: string | null; status: EventStatus;
  slug: string | null; timezone: string; capacity: number | null; venue_name: string | null;
  venue_address: string | null; stream_url: string | null; visibility: EventVisibility;
  starts_at: Date | null; ends_at: Date | null; revision: number; published_at: Date | null;
  cancelled_at: Date | null; cancel_reason: string | null; created_at: Date; updated_at: Date;
}

const COLUMNS = (sql: Sql) => sql`
  id, organization_id, title, description, status, slug, timezone, capacity, venue_name, venue_address,
  stream_url, visibility, starts_at, ends_at, revision, published_at, cancelled_at, cancel_reason, created_at, updated_at
`;

function toRecord(row: EventRow): EventRecord {
  return {
    id: row.id, organizationId: row.organization_id, title: row.title, description: row.description,
    status: row.status, slug: row.slug, timezone: row.timezone, capacity: row.capacity,
    venueName: row.venue_name, venueAddress: row.venue_address, streamUrl: row.stream_url,
    visibility: row.visibility, startsAt: row.starts_at, endsAt: row.ends_at, revision: row.revision,
    publishedAt: row.published_at, cancelledAt: row.cancelled_at, cancelReason: row.cancel_reason,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export function toPublicEvent(event: EventRecord): PublicEvent {
  return {
    id: event.id, slug: event.slug ?? event.id, title: event.title, description: event.description,
    status: event.status, timezone: event.timezone, capacity: event.capacity, venueName: event.venueName,
    venueAddress: event.venueAddress, streamUrl: event.streamUrl, startsAt: event.startsAt, endsAt: event.endsAt,
    publishedAt: event.publishedAt, cancelledAt: event.cancelledAt, cancelReason: event.cancelReason
  };
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === "23505";

export async function createEvent(organizationId: string, actorAccountId: string, fields: EventFields): Promise<EventRecord> {
  if (!isUuid(organizationId)) throw new DomainError("organization_not_found");
  try {
    return await getSqlClient().begin(async tx => {
      const [row] = await tx<EventRow[]>`
        INSERT INTO competitions (organization_id, title, description, slug, timezone, capacity, venue_name,
          venue_address, stream_url, visibility, starts_at, ends_at, created_by_account_id)
        VALUES (${organizationId}, ${fields.title}, ${fields.description}, ${fields.slug}, ${fields.timezone},
          ${fields.capacity}, ${fields.venueName}, ${fields.venueAddress}, ${fields.streamUrl}, ${fields.visibility},
          ${fields.startsAt}, ${fields.endsAt}, ${actorAccountId})
        RETURNING ${COLUMNS(tx)}
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "event.created", subjectType: "competition", subjectId: row!.id,
        details: { slug: fields.slug, visibility: fields.visibility }
      });
      return toRecord(row!);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("event_slug_conflict");
    throw error;
  }
}

async function lockEvent(tx: Sql, organizationId: string, eventId: string): Promise<EventRecord> {
  if (!isUuid(organizationId) || !isUuid(eventId)) throw new DomainError("event_not_found");
  const [row] = await tx<EventRow[]>`
    SELECT ${COLUMNS(tx)} FROM competitions WHERE organization_id = ${organizationId} AND id = ${eventId} FOR UPDATE
  `;
  if (!row) throw new DomainError("event_not_found");
  return toRecord(row);
}

export async function getEvent(organizationId: string, eventId: string): Promise<EventRecord | null> {
  if (!isUuid(organizationId) || !isUuid(eventId)) return null;
  const sql = getSqlClient();
  const [row] = await sql<EventRow[]>`SELECT ${COLUMNS(sql)} FROM competitions WHERE organization_id = ${organizationId} AND id = ${eventId}`;
  return row ? toRecord(row) : null;
}

/** Revisioned edit (If-Match). Slug is locked after publication; terminal states are read-only. */
export async function updateEvent(
  organizationId: string,
  eventId: string,
  actorAccountId: string,
  patch: EventPatch,
  expectedRevision: number
): Promise<EventRecord> {
  try {
    return await getSqlClient().begin(async tx => {
      const current = await lockEvent(tx, organizationId, eventId);
      if (current.revision !== expectedRevision) throw new DomainError("event_revision_conflict");
      const next = applyEventPatch(current.status, current, patch);
      const [row] = await tx<EventRow[]>`
        UPDATE competitions SET title = ${next.title}, description = ${next.description}, slug = ${next.slug},
          timezone = ${next.timezone}, capacity = ${next.capacity}, venue_name = ${next.venueName},
          venue_address = ${next.venueAddress}, stream_url = ${next.streamUrl}, visibility = ${next.visibility},
          starts_at = ${next.startsAt}, ends_at = ${next.endsAt}, revision = revision + 1, updated_at = now()
        WHERE organization_id = ${organizationId} AND id = ${eventId}
        RETURNING ${COLUMNS(tx)}
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "event.updated", subjectType: "competition", subjectId: eventId,
        details: { revision: row!.revision, fields: Object.keys(patch).sort() }
      });
      return toRecord(row!);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("event_slug_conflict");
    throw error;
  }
}

/** Lifecycle transition under a row lock, with append-only history and audit. */
export async function transitionEvent(
  organizationId: string,
  eventId: string,
  actorAccountId: string,
  to: EventStatus,
  expectedRevision: number,
  reason: string | null
): Promise<EventRecord> {
  return getSqlClient().begin(async tx => {
    const current = await lockEvent(tx, organizationId, eventId);
    if (current.revision !== expectedRevision) throw new DomainError("event_revision_conflict");
    const plan = planTransition(current.status, to, current, reason);
    const [row] = await tx<EventRow[]>`
      UPDATE competitions SET status = ${to}, revision = revision + 1, updated_at = now(),
        published_at = ${to === "published" ? tx`COALESCE(published_at, now())` : tx`published_at`},
        cancelled_at = ${to === "cancelled" ? tx`now()` : tx`cancelled_at`},
        cancel_reason = ${to === "cancelled" ? plan.reason : tx`cancel_reason`}
      WHERE organization_id = ${organizationId} AND id = ${eventId}
      RETURNING ${COLUMNS(tx)}
    `;
    await tx`
      INSERT INTO competition_status_history (organization_id, competition_id, from_status, to_status, reason, actor_account_id, revision)
      VALUES (${organizationId}, ${eventId}, ${current.status}, ${to}, ${plan.reason}, ${actorAccountId}, ${row!.revision})
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "event.status_changed", subjectType: "competition", subjectId: eventId,
      details: { from: current.status, to, revision: row!.revision, ...(plan.reason ? { reason: plan.reason } : {}) }
    });
    return toRecord(row!);
  });
}

export async function listEventHistory(organizationId: string, eventId: string) {
  return getSqlClient()<{ from_status: EventStatus; to_status: EventStatus; reason: string | null; actor_account_id: string; revision: number; recorded_at: Date }[]>`
    SELECT from_status, to_status, reason, actor_account_id, revision, recorded_at
    FROM competition_status_history WHERE organization_id = ${organizationId} AND competition_id = ${eventId}
    ORDER BY id
  `;
}

/** Statuses visible outside the producer console (drafts never are). */
const VISIBLE_STATUSES = ["published", "live", "paused", "completed", "cancelled"];

/**
 * Public/member read by id or slug. Anonymous viewers see `public` events;
 * members also see `members` events. Drafts and private events are never returned.
 */
export async function getPublicEvent(organizationId: string, idOrSlug: string, member = false): Promise<PublicEvent | null> {
  if (!isUuid(organizationId)) return null;
  const byId = isUuid(idOrSlug);
  if (!byId && !SLUG_PATTERN.test(idOrSlug)) return null;
  const sql = getSqlClient();
  const visibilities = member ? ["public", "members"] : ["public"];
  const [row] = await sql<EventRow[]>`
    SELECT ${COLUMNS(sql)} FROM competitions
    WHERE organization_id = ${organizationId}
      AND ${byId ? sql`id = ${idOrSlug}` : sql`slug = ${idOrSlug}`}
      AND status = ANY(${VISIBLE_STATUSES}::competition_status[])
      AND visibility = ANY(${visibilities}::text[])
  `;
  return row ? toPublicEvent(toRecord(row)) : null;
}

/** Public/member listing ordered by start time. */
export async function listPublicEvents(
  organizationId: string,
  options: { member?: boolean; limit?: number; offset?: number } = {}
): Promise<PublicEvent[]> {
  if (!isUuid(organizationId)) return [];
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 10_000);
  const sql = getSqlClient();
  const visibilities = options.member ? ["public", "members"] : ["public"];
  const rows = await sql<EventRow[]>`
    SELECT ${COLUMNS(sql)} FROM competitions
    WHERE organization_id = ${organizationId}
      AND status = ANY(${VISIBLE_STATUSES}::competition_status[])
      AND visibility = ANY(${visibilities}::text[])
    ORDER BY starts_at NULLS LAST, id
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(row => toPublicEvent(toRecord(row)));
}

/** Producer console listing (event.manage at tenant scope): every event including drafts. */
export async function listManagedEvents(organizationId: string, options: { limit?: number; offset?: number } = {}): Promise<EventRecord[]> {
  if (!isUuid(organizationId)) return [];
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 10_000);
  const sql = getSqlClient();
  const rows = await sql<EventRow[]>`
    SELECT ${COLUMNS(sql)} FROM competitions WHERE organization_id = ${organizationId}
    ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(toRecord);
}
