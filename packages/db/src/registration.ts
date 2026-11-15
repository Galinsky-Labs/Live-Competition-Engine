import {
  applicationInputSchema, assertApplicationMove, DomainError, isApplicantEditable, parseContestConfig, registrationState,
  type ApplicationStatus
} from "@live-competition-engine/engine";
import type { TransactionSql } from "postgres";
import { getSqlClient } from "./index.ts";
import { recordAudit } from "./audit.ts";
import { lockEvent } from "./events.ts";
import { addEntrantTx, lockStage } from "./stages.ts";

export interface ApplicationRecord {
  id: string; applicantAccountId: string; displayName: string; kind: string; members: string[]; statement: string | null;
  mediaIds: string[]; consentVersion: string; consentedAt: Date; status: ApplicationStatus; waitlistPosition: number | null;
  entryId: string | null; revision: number; submittedAt: Date; updatedAt: Date;
}
interface Row { id: string; applicant_account_id: string; display_name: string; kind: string; members: string[]; statement: string | null; media_ids: string[]; consent_version: string; consented_at: Date; status: ApplicationStatus; waitlist_position: number | null; entry_id: string | null; revision: number; submitted_at: Date; updated_at: Date }
const cols = "id, applicant_account_id, display_name, kind, members, statement, media_ids, consent_version, consented_at, status, waitlist_position, entry_id, revision, submitted_at, updated_at";
const toApp = (r: Row): ApplicationRecord => ({ id: r.id, applicantAccountId: r.applicant_account_id, displayName: r.display_name, kind: r.kind, members: r.members, statement: r.statement, mediaIds: r.media_ids, consentVersion: r.consent_version, consentedAt: r.consented_at, status: r.status, waitlistPosition: r.waitlist_position, entryId: r.entry_id, revision: r.revision, submittedAt: r.submitted_at, updatedAt: r.updated_at });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function openForApplicants(tx: TransactionSql, organizationId: string, eventId: string, now: Date) {
  const event = await lockEvent(tx, organizationId, eventId);
  if (event.status !== "published") throw new DomainError(409, "registration_not_open");
  const config = parseContestConfig(event.config);
  if (!config.eligibility.requiresApplication) throw new DomainError(409, "applications_not_used");
  const state = registrationState(config, now);
  if (state !== "open") throw new DomainError(409, state === "closed" ? "registration_closed" : "registration_not_open");
  return config;
}

async function assertOwnedMedia(tx: TransactionSql, organizationId: string, accountId: string, mediaIds: string[]) {
  if (!mediaIds.length) return;
  const rows = await tx<{ id: string }[]>`SELECT id FROM media_library WHERE organization_id = ${organizationId} AND owner_account_id = ${accountId} AND id IN ${tx(mediaIds)}`;
  if (rows.length !== new Set(mediaIds).size) throw new DomainError(400, "media_not_owned");
}

function validateGroup(config: ReturnType<typeof parseContestConfig>, kind: string, members: string[]) {
  if (config.format === "group" && kind !== "group") throw new DomainError(400, "group_entrant_required");
  const size = config.eligibility.groupSize;
  if (kind === "group" && size && (members.length < size.min || members.length > size.max)) throw new DomainError(400, "group_size_out_of_range");
}

async function logDecision(tx: TransactionSql, organizationId: string, app: { id: string; revision: number }, from: string, to: string, actor: string, role: "applicant" | "producer", reason?: string | null) {
  await tx`INSERT INTO application_decisions (organization_id, application_id, application_revision, from_status, to_status, actor_account_id, actor_role, reason)
    VALUES (${organizationId}, ${app.id}, ${app.revision}, ${from}, ${to}, ${actor}, ${role}, ${reason ?? null})`;
}

/** Applicant submits once per event. Requires membership in the tenant (media ownership is tenant-scoped). */
export async function submitApplication(organizationId: string, eventId: string, accountId: string, input: unknown, now = new Date()): Promise<ApplicationRecord> {
  const data = applicationInputSchema.parse(input);
  return getSqlClient().begin(async tx => {
    const config = await openForApplicants(tx, organizationId, eventId, now);
    if (data.consent.version !== config.registration.consentVersion) throw new DomainError(409, "consent_version_mismatch");
    validateGroup(config, data.kind, data.members);
    await assertOwnedMedia(tx, organizationId, accountId, data.mediaIds);
    const [row] = await tx.unsafe<Row[]>(
      `INSERT INTO applications (organization_id, competition_id, applicant_account_id, display_name, kind, members, statement, media_ids, consent_version, consented_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (competition_id, applicant_account_id) DO NOTHING RETURNING ${cols}`,
      [organizationId, eventId, accountId, data.displayName, data.kind, tx.json(data.members), data.statement ?? null, data.mediaIds, data.consent.version, now] as never[]
    );
    if (!row) throw new DomainError(409, "already_applied");
    await logDecision(tx, organizationId, row, "none", "submitted", accountId, "applicant");
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "application.submitted", subjectType: "application", subjectId: row.id, details: { eventId } });
    return toApp(row);
  });
}

async function lockApplication(tx: TransactionSql, organizationId: string, eventId: string, applicationId: unknown): Promise<ApplicationRecord> {
  if (typeof applicationId !== "string" || !uuid.test(applicationId)) throw new DomainError(400, "invalid_application_id");
  const [row] = await tx.unsafe<Row[]>(`SELECT ${cols} FROM applications WHERE organization_id = $1 AND competition_id = $2 AND id = $3 FOR UPDATE`, [organizationId, eventId, applicationId]);
  if (!row) throw new DomainError(404, "application_not_found");
  return toApp(row);
}

/** Applicant revises their own application while it is still under consideration and registration is open. */
export async function reviseApplication(organizationId: string, eventId: string, accountId: string, applicationId: unknown, expectedRevision: unknown, input: unknown, now = new Date()) {
  const data = applicationInputSchema.parse(input);
  return getSqlClient().begin(async tx => {
    const config = await openForApplicants(tx, organizationId, eventId, now);
    const app = await lockApplication(tx, organizationId, eventId, applicationId);
    if (app.applicantAccountId !== accountId) throw new DomainError(404, "application_not_found");
    if (app.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    if (!isApplicantEditable(app.status)) throw new DomainError(409, "application_locked");
    validateGroup(config, data.kind, data.members);
    await assertOwnedMedia(tx, organizationId, accountId, data.mediaIds);
    const [row] = await tx.unsafe<Row[]>(
      `UPDATE applications SET display_name = $2, kind = $3, members = $4, statement = $5, media_ids = $6, consent_version = $7, consented_at = $8,
         revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING ${cols}`,
      [app.id, data.displayName, data.kind, tx.json(data.members), data.statement ?? null, data.mediaIds, data.consent.version, now] as never[]
    );
    await logDecision(tx, organizationId, row!, app.status, app.status, accountId, "applicant", "revised");
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "application.revised", subjectType: "application", subjectId: app.id, details: { revision: row!.revision } });
    return toApp(row!);
  });
}

/** Applicant withdraws; a selected entrant's entry is withdrawn too (freeing a slot for the waitlist). */
export async function withdrawApplication(organizationId: string, eventId: string, accountId: string, applicationId: unknown) {
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const app = await lockApplication(tx, organizationId, eventId, applicationId);
    if (app.applicantAccountId !== accountId) throw new DomainError(404, "application_not_found");
    assertApplicationMove("applicant", app.status, "withdrawn");
    if (app.entryId) {
      await tx`UPDATE entries SET status = 'withdrawn' WHERE competition_id = ${eventId} AND id = ${app.entryId}`;
      await tx`UPDATE stage_entrants SET status = 'withdrawn' WHERE competition_id = ${eventId} AND entry_id = ${app.entryId} AND status = 'active'`;
    }
    const [row] = await tx.unsafe<Row[]>(`UPDATE applications SET status = 'withdrawn', waitlist_position = NULL, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING ${cols}`, [app.id]);
    await logDecision(tx, organizationId, row!, app.status, "withdrawn", accountId, "applicant");
    await recordAudit(tx, { organizationId, actorAccountId: accountId, action: "application.withdrawn", subjectType: "application", subjectId: app.id });
    return toApp(row!);
  });
}

/** Producer decision (LC-18): versioned, revision-checked, reasons for reversals, entry created on selection. */
export async function decideApplication(organizationId: string, eventId: string, actorAccountId: string, applicationId: unknown, to: unknown, expectedRevision: unknown, reason?: unknown) {
  if (typeof to !== "string" || !["under_review", "selected", "waitlisted", "rejected"].includes(to)) throw new DomainError(400, "invalid_decision");
  const target = to as ApplicationStatus;
  const why = typeof reason === "string" ? reason.trim() : null;
  return getSqlClient().begin(async tx => {
    const event = await lockEvent(tx, organizationId, eventId);
    if (event.status === "completed" || event.status === "cancelled") throw new DomainError(409, "event_closed");
    const app = await lockApplication(tx, organizationId, eventId, applicationId);
    if (app.revision !== expectedRevision) throw new DomainError(409, "revision_conflict");
    assertApplicationMove("producer", app.status, target, why);
    let entryId = app.entryId;
    let waitlistPosition: number | null = null;
    if (target === "selected") {
      if (entryId) {
        await tx`UPDATE entries SET status = 'approved' WHERE competition_id = ${eventId} AND id = ${entryId}`;
      } else {
        const entrant = await addEntrantTx(tx, organizationId, eventId, actorAccountId,
          { displayName: app.displayName, kind: app.kind, members: app.members, accountId: app.applicantAccountId }, "application");
        entryId = entrant.entryId;
      }
    } else if (app.status === "selected" && entryId) {
      await tx`UPDATE entries SET status = 'withdrawn' WHERE competition_id = ${eventId} AND id = ${entryId}`;
      await tx`UPDATE stage_entrants SET status = 'withdrawn' WHERE competition_id = ${eventId} AND entry_id = ${entryId} AND status = 'active'`;
    }
    if (target === "waitlisted") {
      const [pos] = await tx<{ next: number }[]>`SELECT COALESCE(MAX(waitlist_position), 0) + 1 AS next FROM applications WHERE competition_id = ${eventId} AND status = 'waitlisted'`;
      waitlistPosition = pos!.next;
    }
    const [row] = await tx.unsafe<Row[]>(
      `UPDATE applications SET status = $2, waitlist_position = $3, entry_id = $4, revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING ${cols}`,
      [app.id, target, waitlistPosition, entryId]
    );
    await logDecision(tx, organizationId, row!, app.status, target, actorAccountId, "producer", why);
    await recordAudit(tx, { organizationId, actorAccountId, action: `application.${target}`, subjectType: "application", subjectId: app.id, details: { from: app.status, ...(why ? { reason: why } : {}) } });
    return toApp(row!);
  });
}

/** Selects the first waitlisted application (lowest position). Returns null when the waitlist is empty. */
export async function promoteFromWaitlist(organizationId: string, eventId: string, actorAccountId: string) {
  const [next] = await getSqlClient()<{ id: string; revision: number }[]>`
    SELECT id, revision FROM applications WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND status = 'waitlisted'
    ORDER BY waitlist_position LIMIT 1`;
  if (!next) return null;
  return decideApplication(organizationId, eventId, actorAccountId, next.id, "selected", next.revision, "Promoted from waitlist");
}

export async function listApplications(organizationId: string, eventId: string, status?: string): Promise<ApplicationRecord[]> {
  const rows = await getSqlClient().unsafe<Row[]>(
    `SELECT ${cols} FROM applications WHERE organization_id = $1 AND competition_id = $2 ${status ? "AND status = $3" : ""}
     ORDER BY CASE status WHEN 'waitlisted' THEN 1 ELSE 0 END, waitlist_position NULLS FIRST, submitted_at`,
    status ? [organizationId, eventId, status] : [organizationId, eventId]
  );
  return rows.map(toApp);
}

export async function getOwnApplication(organizationId: string, eventId: string, accountId: string): Promise<ApplicationRecord | null> {
  const [row] = await getSqlClient().unsafe<Row[]>(`SELECT ${cols} FROM applications WHERE organization_id = $1 AND competition_id = $2 AND applicant_account_id = $3`, [organizationId, eventId, accountId]);
  return row ? toApp(row) : null;
}

export async function applicationHistory(organizationId: string, applicationId: string) {
  return getSqlClient()<{ application_revision: number; from_status: string; to_status: string; actor_role: string; reason: string | null; decided_at: Date }[]>`
    SELECT application_revision, from_status, to_status, actor_role, reason, decided_at FROM application_decisions
    WHERE organization_id = ${organizationId} AND application_id = ${applicationId} ORDER BY id`;
}

/* ---------- lineup (LC-18 slot assignment) ---------- */

export interface LineupSlot { performanceId: string; entryId: string; displayName: string; ordinal: number; status: string; startedAt: Date | null; completedAt: Date | null }

export async function listLineup(organizationId: string, eventId: string, stageId: string): Promise<LineupSlot[]> {
  const rows = await getSqlClient()<{ id: string; entry_id: string; display_name: string; ordinal: number; status: string; started_at: Date | null; completed_at: Date | null }[]>`
    SELECT pf.id, pf.entry_id, p.display_name, pf.ordinal, pf.status::text AS status, pf.started_at, pf.completed_at
    FROM performances pf JOIN entries e ON e.id = pf.entry_id JOIN participants p ON p.id = e.participant_id
    WHERE pf.organization_id = ${organizationId} AND pf.competition_id = ${eventId} AND pf.round_id = ${stageId}
    ORDER BY pf.ordinal`;
  return rows.map(r => ({ performanceId: r.id, entryId: r.entry_id, displayName: r.display_name, ordinal: r.ordinal, status: r.status, startedAt: r.started_at, completedAt: r.completed_at }));
}

/**
 * Sets the running order for a scheduled stage. Entries must be approved and, when the stage
 * has seeded entrants, active stage entrants. Existing queued slots are replaced.
 */
export async function setLineup(organizationId: string, eventId: string, stageId: unknown, actorAccountId: string, entryIds: unknown) {
  if (!Array.isArray(entryIds) || entryIds.length > 500 || entryIds.some(id => typeof id !== "string" || !uuid.test(id))) throw new DomainError(400, "invalid_lineup");
  const ids = entryIds as string[];
  if (new Set(ids).size !== ids.length) throw new DomainError(400, "duplicate_entrant");
  return getSqlClient().begin(async tx => {
    await lockEvent(tx, organizationId, eventId);
    const stage = await lockStage(tx, organizationId, eventId, stageId);
    if (stage.status !== "scheduled") throw new DomainError(409, "stage_locked");
    const approved = ids.length ? await tx<{ id: string }[]>`SELECT id FROM entries WHERE organization_id = ${organizationId} AND competition_id = ${eventId} AND status = 'approved' AND id IN ${tx(ids)}` : [];
    if (approved.length !== ids.length) throw new DomainError(400, "entry_not_eligible");
    const seeded = await tx<{ entry_id: string }[]>`SELECT entry_id FROM stage_entrants WHERE round_id = ${stage.id} AND status = 'active'`;
    if (seeded.length && ids.some(id => !seeded.some(s => s.entry_id === id))) throw new DomainError(400, "entry_not_in_stage");
    await tx`DELETE FROM performances WHERE round_id = ${stage.id} AND status = 'queued'`;
    const [remaining] = await tx`SELECT 1 FROM performances WHERE round_id = ${stage.id} LIMIT 1`;
    if (remaining) throw new DomainError(409, "lineup_has_started_performances");
    for (const [index, id] of ids.entries()) {
      await tx`INSERT INTO performances (organization_id, competition_id, round_id, entry_id, ordinal) VALUES (${organizationId}, ${eventId}, ${stage.id}, ${id}, ${index + 1})`;
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "lineup.set", subjectType: "stage", subjectId: stage.id, details: { entryIds: ids } });
    return ids.length;
  });
}
