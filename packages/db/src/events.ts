import {
  assertTransition,
  DomainError,
  eventInputSchema,
  eventPatchSchema,
  isEditableStatus,
  isPublicStatus,
  parseContestConfig,
  publishBlockers,
  safeParseContestConfig,
  type EventStatus
} from "@live-competition-engine/engine";
import type { TransactionSql } from "postgres";
import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";

export interface EventRecord {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  slug: string | null;
  status: EventStatus;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
  capacity: number | null;
  venue: { name: string; address?: string; accessibilityNotes?: string } | null;
  remote: boolean;
  revision: number;
  config: Record<string, unknown>;
  templateId: string | null;
  templateVersion: number | null;
  publishedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

interface EventRow {
  id: string; organization_id: string; title: string; description: string | null; slug: string | null; status: EventStatus;
  timezone: string; starts_at: Date | null; ends_at: Date | null; capacity: number | null; venue: EventRecord["venue"];
  remote: boolean; revision: number; config: Record<string, unknown>; template_id: string | null; template_version: number | null;
  published_at: Date | null; cancelled_at: Date | null; cancel_reason: string | null;
}

const toEvent = (r: EventRow): EventRecord => ({
  id: r.id, organizationId: r.organization_id, title: r.title, description: r.description, slug: r.slug, status: r.status,
  timezone: r.timezone, startsAt: r.starts_at, endsAt: r.ends_at, capacity: r.capacity, venue: r.venue, remote: r.remote,
  revision: r.revision, config: r.config, templateId: r.template_id, templateVersion: r.template_version,
  publishedAt: r.published_at, cancelledAt: r.cancelled_at, cancelReason: r.cancel_reason
});

const columns = `id, organization_id, title, description, slug, status, timezone, starts_at, ends_at, capacity, venue, remote,
  revision, config, template_id, template_version, published_at, cancelled_at, cancel_reason`;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Locks the event row for update inside a transaction; scoped to the tenant. */
export async function lockEvent(tx: TransactionSql, organizationId: string, eventId: string): Promise<EventRecord> {
  if (!uuid.test(eventId)) throw new DomainError(404, "event_not_found");
  const [row] = await tx.unsafe<EventRow[]>(`SELECT ${columns} FROM competitions WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [organizationId, eventId]);
  if (!row) throw new DomainError(404, "event_not_found");
  return toEvent(row);
}

export async function getEvent(organizationId: string, eventId: string): Promise<EventRecord | null> {
  if (!uuid.test(eventId)) return null;
  const [row] = await getSqlClient().unsafe<EventRow[]>(`SELECT ${columns} FROM competitions WHERE organization_id = $1 AND id = $2`, [organizationId, eventId]);
  return row ? toEvent(row) : null;
}

/** Public view: drafts are never returned. */
export async function getPublicEvent(organizationId: string, eventId: string): Promise<EventRecord | null> {
  const event = await getEvent(organizationId, eventId);
  return event && isPublicStatus(event.status) ? event : null;
}

export async function listEvents(organizationId: string, options: { includeDrafts: boolean }): Promise<EventRecord[]> {
  const rows = await getSqlClient().unsafe<EventRow[]>(
    `SELECT ${columns} FROM competitions WHERE organization_id = $1 ${options.includeDrafts ? "" : "AND status <> 'draft'"}
     ORDER BY starts_at NULLS LAST, created_at DESC LIMIT 200`,
    [organizationId]
  );
  return rows.map(toEvent);
}

export async function createEvent(organizationId: string, actorAccountId: string, input: unknown): Promise<EventRecord> {
  const data = eventInputSchema.parse(input);
  const sql = getSqlClient();
  return sql.begin(async tx => {
    let row: EventRow | undefined;
    try {
      [row] = await tx.unsafe<EventRow[]>(
        `INSERT INTO competitions (organization_id, title, description, slug, timezone, starts_at, ends_at, capacity, venue, remote, config, created_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${columns}`,
        [organizationId, data.title, data.description ?? null, data.slug ?? null, data.timezone, data.startsAt ?? null, data.endsAt ?? null,
          data.capacity ?? null, data.venue ? tx.json(data.venue) : null, data.remote, tx.json(parseContestConfig({}) as never), actorAccountId] as never[]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError(409, "event_slug_taken");
      throw error;
    }
    const event = toEvent(row!);
    await recordAudit(tx, { organizationId, actorAccountId, action: "event.created", subjectType: "event", subjectId: event.id, details: { title: event.title } });
    return event;
  });
}

const expectRevision = (event: EventRecord, expected: unknown) => {
  if (typeof expected !== "number" || !Number.isInteger(expected)) throw new DomainError(400, "expected_revision_required");
  if (event.revision !== expected) throw new DomainError(409, "revision_conflict");
};

export async function updateEvent(organizationId: string, eventId: string, actorAccountId: string, expectedRevision: unknown, patchInput: unknown): Promise<EventRecord> {
  const patch = eventPatchSchema.parse(patchInput);
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    expectRevision(event, expectedRevision);
    if (!isEditableStatus(event.status)) throw new DomainError(409, "event_locked");
    const next = {
      title: patch.title ?? event.title,
      description: patch.description === undefined ? event.description : patch.description,
      timezone: patch.timezone ?? event.timezone,
      startsAt: patch.startsAt === undefined ? event.startsAt : patch.startsAt ? new Date(patch.startsAt) : null,
      endsAt: patch.endsAt === undefined ? event.endsAt : patch.endsAt ? new Date(patch.endsAt) : null,
      capacity: patch.capacity === undefined ? event.capacity : patch.capacity,
      venue: patch.venue === undefined ? event.venue : patch.venue,
      remote: patch.remote ?? event.remote
    };
    if (next.startsAt && next.endsAt && next.endsAt <= next.startsAt) throw new DomainError(400, "invalid_time_order");
    if (event.status === "published") {
      const blockers = publishBlockers({ ...next, config: event.config });
      if (blockers.length) throw new DomainError(400, "published_event_would_become_invalid");
    }
    const [row] = await tx.unsafe<EventRow[]>(
      `UPDATE competitions SET title = $3, description = $4, timezone = $5, starts_at = $6, ends_at = $7, capacity = $8, venue = $9,
         remote = $10, revision = revision + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 RETURNING ${columns}`,
      [organizationId, eventId, next.title, next.description, next.timezone, next.startsAt, next.endsAt, next.capacity,
        next.venue ? tx.json(next.venue as never) : null, next.remote] as never[]
    );
    await recordAudit(tx, { organizationId, actorAccountId, action: "event.updated", subjectType: "event", subjectId: eventId, details: { fields: Object.keys(patch), revision: row!.revision } });
    return toEvent(row!);
  });
}

export async function transitionEvent(organizationId: string, eventId: string, actorAccountId: string, to: EventStatus, expectedRevision: unknown, reason?: string): Promise<EventRecord> {
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    expectRevision(event, expectedRevision);
    assertTransition(event.status, to);
    if (to === "published") {
      const blockers = publishBlockers(event);
      if (blockers.length) throw Object.assign(new DomainError(409, "event_not_publishable"), { blockers });
    }
    if (to === "cancelled" && (!reason || reason.trim().length < 3)) throw new DomainError(400, "cancel_reason_required");
    const [row] = await tx.unsafe<EventRow[]>(
      `UPDATE competitions SET status = $3::competition_status, revision = revision + 1, updated_at = now(),
         published_at = CASE WHEN $5::text = 'published' AND published_at IS NULL THEN now() ELSE published_at END,
         cancelled_at = CASE WHEN $5::text = 'cancelled' THEN now() ELSE cancelled_at END,
         cancel_reason = CASE WHEN $5::text = 'cancelled' THEN $4::text ELSE cancel_reason END
       WHERE organization_id = $1 AND id = $2 RETURNING ${columns}`,
      [organizationId, eventId, to, reason?.trim() ?? null, to]
    );
    await recordAudit(tx, { organizationId, actorAccountId, action: `event.${to}`, subjectType: "event", subjectId: eventId, details: { from: event.status, ...(reason ? { reason } : {}) } });
    return toEvent(row!);
  });
}

/** Replaces the event's contest configuration; allowed only while the event is a draft. */
export async function setEventConfig(organizationId: string, eventId: string, actorAccountId: string, expectedRevision: unknown, configInput: unknown): Promise<EventRecord> {
  const parsed = safeParseContestConfig(configInput);
  if (!parsed.ok) throw Object.assign(new DomainError(400, "invalid_config"), { issues: parsed.issues });
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    expectRevision(event, expectedRevision);
    if (event.status !== "draft") throw new DomainError(409, "config_locked_after_publish");
    const [row] = await tx.unsafe<EventRow[]>(
      `UPDATE competitions SET config = $3, template_id = NULL, template_version = NULL, revision = revision + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 RETURNING ${columns}`,
      [organizationId, eventId, tx.json(parsed.config as never)] as never[]
    );
    await recordAudit(tx, { organizationId, actorAccountId, action: "event.config_set", subjectType: "event", subjectId: eventId, details: { revision: row!.revision } });
    return toEvent(row!);
  });
}

export interface TemplateRecord { id: string; key: string; version: number; name: string; config: Record<string, unknown>; createdAt: Date }

/** Publishes a new immutable template version (version = previous + 1). */
export async function createTemplateVersion(organizationId: string, actorAccountId: string, key: unknown, name: unknown, configInput: unknown): Promise<TemplateRecord> {
  if (typeof key !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(key)) throw new DomainError(400, "invalid_template_key");
  if (typeof name !== "string" || name.trim().length < 1 || name.length > 200) throw new DomainError(400, "invalid_template_name");
  const parsed = safeParseContestConfig(configInput);
  if (!parsed.ok) throw Object.assign(new DomainError(400, "invalid_config"), { issues: parsed.issues });
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`template:${organizationId}:${key}`}))`;
    const [row] = await tx<{ id: string; version: number; created_at: Date }[]>`
      INSERT INTO competition_templates (organization_id, key, version, name, config, created_by_account_id)
      SELECT ${organizationId}, ${key}, COALESCE(MAX(version), 0) + 1, ${name.trim()}, ${tx.json(parsed.config as never)}, ${actorAccountId}
      FROM competition_templates WHERE organization_id = ${organizationId} AND key = ${key}
      RETURNING id, version, created_at
    `;
    await recordAudit(tx, { organizationId, actorAccountId, action: "template.version_created", subjectType: "template", subjectId: row!.id, details: { key, version: row!.version } });
    return { id: row!.id, key, version: row!.version, name: name.trim(), config: parsed.config as Record<string, unknown>, createdAt: row!.created_at };
  });
}

export async function listTemplates(organizationId: string): Promise<TemplateRecord[]> {
  const rows = await getSqlClient()<{ id: string; key: string; version: number; name: string; config: Record<string, unknown>; created_at: Date }[]>`
    SELECT id, key, version, name, config, created_at FROM competition_templates
    WHERE organization_id = ${organizationId} ORDER BY key, version DESC
  `;
  return rows.map(r => ({ id: r.id, key: r.key, version: r.version, name: r.name, config: r.config, createdAt: r.created_at }));
}

/** Snapshots a template version into a draft event so later template versions never change it. */
export async function applyTemplate(organizationId: string, eventId: string, actorAccountId: string, expectedRevision: unknown, templateId: unknown): Promise<EventRecord> {
  if (typeof templateId !== "string" || !uuid.test(templateId)) throw new DomainError(400, "invalid_template_id");
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    expectRevision(event, expectedRevision);
    if (event.status !== "draft") throw new DomainError(409, "config_locked_after_publish");
    const [template] = await tx<{ id: string; version: number; config: Record<string, unknown> }[]>`
      SELECT id, version, config FROM competition_templates WHERE organization_id = ${organizationId} AND id = ${templateId}
    `;
    if (!template) throw new DomainError(404, "template_not_found");
    const [row] = await tx.unsafe<EventRow[]>(
      `UPDATE competitions SET config = $3, template_id = $4, template_version = $5, revision = revision + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 RETURNING ${columns}`,
      [organizationId, eventId, tx.json(template.config as never), template.id, template.version] as never[]
    );
    await recordAudit(tx, { organizationId, actorAccountId, action: "event.template_applied", subjectType: "event", subjectId: eventId, details: { templateId: template.id, version: template.version } });
    return toEvent(row!);
  });
}
