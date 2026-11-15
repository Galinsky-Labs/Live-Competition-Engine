import type postgres from "postgres";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  assertCapacity, assertTransition, assertWindowOpen, decisionRequiresReason, isApplicationStatus,
  parseApplicationForm, validateAnswers, validateDisplayName, validateReason,
  type AnswerValue, type ApplicationActor, type ApplicationFormDefinition, type ApplicationStatus, type FormField
} from "@live-competition-engine/domain/applications";
import { recordAudit, type Sql } from "./audit.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-17 applications and registration. Every function takes the tenant first and
 * filters by it. Callers (HTTP handlers) authenticate; these functions enforce the
 * applicant/producer rules, deadlines, the status machine and the `applications` flag.
 */

export interface ApplicationForm extends ApplicationFormDefinition {
  competitionId: string;
  revision: number;
  updatedAt: Date;
}

interface FormRow {
  id: string; competition_id: string; opens_at: Date; closes_at: Date; capacity: number | null;
  contact_consent_key: string | null; fields: FormField[]; revision: number; updated_at: Date;
}

export interface ApplicationRow {
  id: string; organization_id: string; competition_id: string; applicant_account_id: string; display_name: string;
  status: ApplicationStatus; answers: Record<string, AnswerValue>; form_revision: number; revision: number;
  waitlist_position: number | null; waitlisted_at: Date | null; participant_id: string | null; entry_id: string | null;
  submitted_at: Date | null; decided_at: Date | null; withdrawn_at: Date | null; created_at: Date; updated_at: Date;
}

export interface ApplicantView {
  id: string; competitionId: string; displayName: string; status: ApplicationStatus; answers: Record<string, AnswerValue>;
  formRevision: number; revision: number; waitlistPosition: number | null; entryId: string | null;
  submittedAt: Date | null; decidedAt: Date | null; withdrawnAt: Date | null; createdAt: Date;
}

export interface ReviewView extends Omit<ApplicantView, "formRevision" | "withdrawnAt" | "createdAt"> {
  consents: { key: string; version: string; acceptedAt: Date }[];
  media: { fieldKey: string; mediaId: string }[];
  /** Present only when the applicant accepted the form's contact-sharing consent. */
  contactEmail: string | null;
}

export interface DecisionRecord {
  revision: number; actorKind: ApplicationActor; actorAccountId: string | null;
  previousStatus: ApplicationStatus; newStatus: ApplicationStatus; reason: string | null; decidedAt: Date;
}

const toForm = (row: FormRow): ApplicationForm => ({
  competitionId: row.competition_id, opensAt: row.opens_at, closesAt: row.closes_at, capacity: row.capacity,
  contactConsentKey: row.contact_consent_key, fields: row.fields, revision: row.revision, updatedAt: row.updated_at
});

const toApplicant = (row: ApplicationRow): ApplicantView => ({
  id: row.id, competitionId: row.competition_id, displayName: row.display_name, status: row.status, answers: row.answers,
  formRevision: row.form_revision, revision: row.revision, waitlistPosition: row.waitlist_position, entryId: row.entry_id,
  submittedAt: row.submitted_at, decidedAt: row.decided_at, withdrawnAt: row.withdrawn_at, createdAt: row.created_at
});

function ids(...values: string[]): void {
  if (!values.every(isUuid)) throw new DomainError("not_found");
}

function expectRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DomainError("invalid_expected_revision");
  return value as number;
}

async function feature(organizationId: string, competitionId: string, accountId: string): Promise<void> {
  try {
    await requireEnabledFeature("applications", { organizationId, eventId: competitionId, accountId });
  } catch (error) {
    // The flag store refuses scopes outside the tenant (non-member account, foreign event): fail closed as 403.
    if (error instanceof Error && !(error instanceof DomainError) && /scope denied/.test(error.message)) throw new DomainError("forbidden");
    throw error;
  }
}

async function loadForm(tx: Sql, organizationId: string, competitionId: string, lock = false): Promise<FormRow> {
  const [row] = await tx<FormRow[]>`
    SELECT id, competition_id, opens_at, closes_at, capacity, contact_consent_key, fields, revision, updated_at
    FROM application_forms WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
    ${lock ? tx`FOR UPDATE` : tx``}
  `;
  if (!row) throw new DomainError("application_form_not_found");
  return row;
}

async function loadApplication(tx: Sql, organizationId: string, competitionId: string, applicationId: string, lock = true): Promise<ApplicationRow> {
  const [row] = await tx<ApplicationRow[]>`
    SELECT * FROM applications
    WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND id = ${applicationId}
    ${lock ? tx`FOR UPDATE` : tx``}
  `;
  if (!row) throw new DomainError("application_not_found");
  return row;
}

export async function getApplicationForm(organizationId: string, competitionId: string): Promise<ApplicationForm | null> {
  ids(organizationId, competitionId);
  try {
    return toForm(await loadForm(getSqlClient(), organizationId, competitionId));
  } catch (error) {
    if (error instanceof DomainError && error.code === "application_form_not_found") return null;
    throw error;
  }
}

/** Create (expectedRevision 0) or replace the competition's form. Producer-only at the HTTP layer. */
export async function saveApplicationForm(
  organizationId: string, competitionId: string, actorAccountId: string, input: unknown, expectedRevision: number
): Promise<ApplicationForm> {
  ids(organizationId, competitionId, actorAccountId);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError("invalid_expected_revision");
  const form = parseApplicationForm(input);
  await feature(organizationId, competitionId, actorAccountId);
  return getSqlClient().begin(async tx => {
    const [competition] = await tx`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId}`;
    if (!competition) throw new DomainError("competition_not_found");
    const fields = tx.json(form.fields as unknown as postgres.JSONValue);
    let rows: FormRow[];
    if (expectedRevision === 0) {
      rows = await tx<FormRow[]>`
        INSERT INTO application_forms (organization_id, competition_id, opens_at, closes_at, capacity, contact_consent_key, fields, updated_by_account_id)
        VALUES (${organizationId}, ${competitionId}, ${form.opensAt}, ${form.closesAt}, ${form.capacity}, ${form.contactConsentKey}, ${fields}, ${actorAccountId})
        ON CONFLICT (organization_id, competition_id) DO NOTHING
        RETURNING id, competition_id, opens_at, closes_at, capacity, contact_consent_key, fields, revision, updated_at
      `;
    } else {
      rows = await tx<FormRow[]>`
        UPDATE application_forms SET opens_at = ${form.opensAt}, closes_at = ${form.closesAt}, capacity = ${form.capacity},
          contact_consent_key = ${form.contactConsentKey}, fields = ${fields}, revision = revision + 1,
          updated_by_account_id = ${actorAccountId}, updated_at = now()
        WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND revision = ${expectedRevision}
        RETURNING id, competition_id, opens_at, closes_at, capacity, contact_consent_key, fields, revision, updated_at
      `;
    }
    if (rows.length !== 1) throw new DomainError("application_form_revision_conflict");
    const row = rows[0]!;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "application_form.saved", subjectType: "competition", subjectId: competitionId,
      details: { revision: row.revision, fieldCount: form.fields.length, capacity: form.capacity, closesAt: form.closesAt.toISOString() }
    });
    return toForm(row);
  });
}

async function syncMedia(tx: Sql, organizationId: string, application: { id: string; applicant_account_id: string }, media: { fieldKey: string; mediaId: string }[]): Promise<void> {
  if (media.length) {
    const mediaIds = [...new Set(media.map(m => m.mediaId))];
    const owned = await tx<{ id: string }[]>`
      SELECT id FROM media_library
      WHERE organization_id = ${organizationId} AND id = ANY(${mediaIds}::uuid[])
        AND owner_account_id = ${application.applicant_account_id} AND revoked_at IS NULL
    `;
    // Media from another tenant, another account, or withdrawn media is indistinguishable: all rejected.
    if (owned.length !== mediaIds.length) throw new DomainError("application_media_not_found");
  }
  await tx`DELETE FROM application_media WHERE organization_id = ${organizationId} AND application_id = ${application.id}`;
  for (const item of media) {
    await tx`INSERT INTO application_media (organization_id, application_id, field_key, media_id)
      VALUES (${organizationId}, ${application.id}, ${item.fieldKey}, ${item.mediaId})`;
  }
}

/**
 * Start (or return) the account's active application. Idempotent: a second call returns
 * the existing non-withdrawn application with `created: false` rather than a duplicate.
 */
export async function createApplication(
  organizationId: string, competitionId: string, accountId: string,
  input: { displayName: unknown; answers?: unknown }, now = new Date()
): Promise<{ application: ApplicantView; created: boolean }> {
  ids(organizationId, competitionId, accountId);
  const displayName = validateDisplayName(input.displayName);
  await feature(organizationId, competitionId, accountId);
  const sql = getSqlClient();
  const existing = async () => {
    const [row] = await sql<ApplicationRow[]>`SELECT * FROM applications WHERE organization_id = ${organizationId}
      AND competition_id = ${competitionId} AND applicant_account_id = ${accountId} AND status <> 'withdrawn'`;
    return row;
  };
  const found = await existing();
  if (found) return { application: toApplicant(found), created: false };
  try {
    return await sql.begin(async tx => {
      const form = await loadForm(tx, organizationId, competitionId);
      assertWindowOpen(toForm(form), now);
      const normalized = validateAnswers(toForm(form), input.answers ?? {}, { complete: false });
      const [row] = await tx<ApplicationRow[]>`
        INSERT INTO applications (organization_id, competition_id, applicant_account_id, display_name, answers, form_revision, created_at, updated_at)
        VALUES (${organizationId}, ${competitionId}, ${accountId}, ${displayName},
          ${tx.json(normalized.answers as postgres.JSONValue)}, ${form.revision}, ${now}, ${now})
        RETURNING *
      `;
      await syncMedia(tx, organizationId, row!, normalized.media);
      await recordAudit(tx, {
        organizationId, actorAccountId: accountId, action: "application.created", subjectType: "application", subjectId: row!.id,
        details: { competitionId }
      });
      return { application: toApplicant(row!), created: true };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      const raced = await existing();
      if (raced) return { application: toApplicant(raced), created: false };
    }
    throw error;
  }
}

function owned(row: ApplicationRow, accountId: string): void {
  // Another account's application is reported as missing, never as forbidden.
  if (row.applicant_account_id !== accountId) throw new DomainError("application_not_found");
}

/** Edit answers/display name while the application is still a draft and the window is open. */
export async function updateApplicationDraft(
  organizationId: string, competitionId: string, applicationId: string, accountId: string,
  input: { displayName?: unknown; answers?: unknown; expectedRevision: unknown }, now = new Date()
): Promise<ApplicantView> {
  ids(organizationId, competitionId, applicationId, accountId);
  const expected = expectRevision(input.expectedRevision);
  const displayName = input.displayName === undefined ? undefined : validateDisplayName(input.displayName);
  await feature(organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const form = await loadForm(tx, organizationId, competitionId);
    const app = await loadApplication(tx, organizationId, competitionId, applicationId);
    owned(app, accountId);
    if (app.status !== "draft") throw new DomainError("invalid_state_not_draft");
    if (app.revision !== expected) throw new DomainError("application_revision_conflict");
    assertWindowOpen(toForm(form), now);
    const normalized = input.answers === undefined ? null : validateAnswers(toForm(form), input.answers, { complete: false });
    const [row] = await tx<ApplicationRow[]>`
      UPDATE applications SET
        display_name = ${displayName ?? app.display_name},
        answers = ${normalized ? tx.json(normalized.answers as postgres.JSONValue) : tx.json(app.answers as postgres.JSONValue)},
        form_revision = ${form.revision}, revision = revision + 1, updated_at = ${now}
      WHERE id = ${app.id} AND revision = ${expected}
      RETURNING *
    `;
    if (!row) throw new DomainError("application_revision_conflict");
    if (normalized) await syncMedia(tx, organizationId, app, normalized.media);
    return toApplicant(row);
  });
}

interface TransitionInput {
  organizationId: string; competitionId: string; form: FormRow; app: ApplicationRow; to: ApplicationStatus;
  actorKind: ApplicationActor; actorAccountId: string | null; reason: string | null; now: Date;
}

async function ensureEntry(tx: Sql, organizationId: string, competitionId: string, app: ApplicationRow): Promise<{ participantId: string; entryId: string }> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`participant:${organizationId}:${app.applicant_account_id}`}, 0))`;
  let [participant] = await tx<{ id: string }[]>`
    SELECT id FROM participants WHERE organization_id = ${organizationId} AND account_id = ${app.applicant_account_id}
    ORDER BY created_at, id LIMIT 1
  `;
  if (!participant) {
    [participant] = await tx<{ id: string }[]>`
      INSERT INTO participants (organization_id, display_name, account_id)
      VALUES (${organizationId}, ${app.display_name}, ${app.applicant_account_id}) RETURNING id
    `;
  }
  const [entry] = await tx<{ id: string }[]>`
    INSERT INTO entries (organization_id, competition_id, participant_id, status)
    VALUES (${organizationId}, ${competitionId}, ${participant!.id}, 'approved')
    ON CONFLICT (competition_id, participant_id) DO UPDATE SET status = 'approved'
    RETURNING id
  `;
  return { participantId: participant!.id, entryId: entry!.id };
}

/** Apply one state change: domain check, side effects, revision bump, history row, audit. */
async function transition(tx: Sql, input: TransitionInput): Promise<ApplicationRow> {
  const { organizationId, competitionId, app, to, now } = input;
  assertTransition(app.status, to, input.actorKind);
  let participantId = app.participant_id;
  let entryId = app.entry_id;
  let waitlistPosition: number | null = null;
  let waitlistedAt: Date | null = null;
  if (to === "selected") {
    const [selected] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM applications
      WHERE organization_id = ${organizationId} AND competition_id = ${competitionId} AND status = 'selected'
    `;
    assertCapacity(input.form.capacity, selected!.count);
    ({ participantId, entryId } = await ensureEntry(tx, organizationId, competitionId, app));
  } else if (to === "waitlisted") {
    const [position] = await tx<{ next: number }[]>`
      SELECT coalesce(max(waitlist_position), 0)::int + 1 AS next FROM applications WHERE competition_id = ${competitionId}
    `;
    waitlistPosition = position!.next;
    waitlistedAt = now;
  } else if (to === "withdrawn" && app.status === "selected" && app.entry_id) {
    await tx`UPDATE entries SET status = 'withdrawn' WHERE organization_id = ${organizationId} AND id = ${app.entry_id}`;
  }
  const [row] = await tx<ApplicationRow[]>`
    UPDATE applications SET
      status = ${to}, revision = revision + 1, updated_at = ${now},
      waitlist_position = ${waitlistPosition}, waitlisted_at = ${waitlistedAt ?? app.waitlisted_at},
      participant_id = ${participantId}, entry_id = ${entryId},
      submitted_at = ${to === "submitted" ? now : app.submitted_at},
      decided_at = ${input.actorKind === "applicant" ? app.decided_at : now},
      withdrawn_at = ${to === "withdrawn" ? now : null}
    WHERE id = ${app.id} AND revision = ${app.revision}
    RETURNING *
  `;
  if (!row) throw new DomainError("application_revision_conflict");
  await tx`
    INSERT INTO application_decisions (organization_id, competition_id, application_id, revision, actor_kind, actor_account_id,
      previous_status, new_status, reason, decided_at)
    VALUES (${organizationId}, ${competitionId}, ${app.id}, ${row.revision}, ${input.actorKind}, ${input.actorAccountId},
      ${app.status}, ${to}, ${input.reason}, ${now})
  `;
  await recordAudit(tx, {
    organizationId, actorAccountId: input.actorAccountId, action: `application.${to}`, subjectType: "application", subjectId: app.id,
    details: { competitionId, previousStatus: app.status, revision: row.revision, actorKind: input.actorKind, reason: input.reason, entryId: row.entry_id }
  });
  if (to === "withdrawn" && app.status === "selected") await promoteFromWaitlist(tx, input.form, organizationId, competitionId, now);
  return row;
}

/** When a selected entrant withdraws, the next waitlisted application is selected automatically. */
async function promoteFromWaitlist(tx: Sql, form: FormRow, organizationId: string, competitionId: string, now: Date): Promise<void> {
  const [next] = await tx<ApplicationRow[]>`
    SELECT * FROM applications WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      AND status = 'waitlisted'
    ORDER BY waitlist_position, waitlisted_at, id LIMIT 1 FOR UPDATE
  `;
  if (!next) return;
  await transition(tx, { organizationId, competitionId, form, app: next, to: "selected", actorKind: "system", actorAccountId: null, reason: "waitlist_promotion", now });
}

/**
 * Submit a draft. Idempotent: re-submitting an already submitted (or later) application
 * returns it unchanged. Required fields, consents and media ownership are checked here.
 */
export async function submitApplication(
  organizationId: string, competitionId: string, applicationId: string, accountId: string, expectedRevision: unknown, now = new Date()
): Promise<{ application: ApplicantView; changed: boolean }> {
  ids(organizationId, competitionId, applicationId, accountId);
  const expected = expectRevision(expectedRevision);
  await feature(organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const form = await loadForm(tx, organizationId, competitionId);
    const app = await loadApplication(tx, organizationId, competitionId, applicationId);
    owned(app, accountId);
    if (app.status !== "draft" && app.status !== "withdrawn" && app.submitted_at) return { application: toApplicant(app), changed: false };
    if (app.revision !== expected) throw new DomainError("application_revision_conflict");
    assertWindowOpen(toForm(form), now);
    const normalized = validateAnswers(toForm(form), app.answers, { complete: true });
    await syncMedia(tx, organizationId, app, normalized.media);
    for (const consent of normalized.consents) {
      await tx`INSERT INTO application_consents (organization_id, application_id, consent_key, consent_version, accepted_by_account_id, accepted_at)
        VALUES (${organizationId}, ${app.id}, ${consent.key}, ${consent.version}, ${accountId}, ${now}) ON CONFLICT DO NOTHING`;
    }
    const row = await transition(tx, { organizationId, competitionId, form, app, to: "submitted", actorKind: "applicant", actorAccountId: accountId, reason: null, now });
    return { application: toApplicant(row), changed: true };
  });
}

/** Withdraw at any time before a terminal state. Withdrawing a selection promotes the waitlist. */
export async function withdrawApplication(
  organizationId: string, competitionId: string, applicationId: string, accountId: string,
  input: { expectedRevision: unknown; reason?: unknown }, now = new Date()
): Promise<ApplicantView> {
  ids(organizationId, competitionId, applicationId, accountId);
  const expected = expectRevision(input.expectedRevision);
  const reason = validateReason(input.reason, false);
  await feature(organizationId, competitionId, accountId);
  return getSqlClient().begin(async tx => {
    const form = await loadForm(tx, organizationId, competitionId, true);
    const app = await loadApplication(tx, organizationId, competitionId, applicationId);
    owned(app, accountId);
    if (app.status === "withdrawn") return toApplicant(app);
    if (app.revision !== expected) throw new DomainError("application_revision_conflict");
    return toApplicant(await transition(tx, { organizationId, competitionId, form, app, to: "withdrawn", actorKind: "applicant", actorAccountId: accountId, reason, now }));
  });
}

export async function getOwnApplication(organizationId: string, competitionId: string, accountId: string): Promise<ApplicantView | null> {
  ids(organizationId, competitionId, accountId);
  const [row] = await getSqlClient()<ApplicationRow[]>`
    SELECT * FROM applications WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      AND applicant_account_id = ${accountId}
    ORDER BY (status <> 'withdrawn') DESC, created_at DESC LIMIT 1
  `;
  return row ? toApplicant(row) : null;
}

export async function getApplicationForApplicant(organizationId: string, competitionId: string, applicationId: string, accountId: string): Promise<ApplicantView> {
  ids(organizationId, competitionId, applicationId, accountId);
  const app = await loadApplication(getSqlClient(), organizationId, competitionId, applicationId, false);
  owned(app, accountId);
  return toApplicant(app);
}

async function reviewViews(sql: Sql, organizationId: string, rows: ApplicationRow[], contactConsentKey: string | null): Promise<ReviewView[]> {
  if (!rows.length) return [];
  const appIds = rows.map(r => r.id);
  const consents = await sql<{ application_id: string; consent_key: string; consent_version: string; accepted_at: Date }[]>`
    SELECT application_id, consent_key, consent_version, accepted_at FROM application_consents
    WHERE organization_id = ${organizationId} AND application_id = ANY(${appIds}::uuid[]) ORDER BY accepted_at, consent_key
  `;
  const media = await sql<{ application_id: string; field_key: string; media_id: string }[]>`
    SELECT application_id, field_key, media_id FROM application_media
    WHERE organization_id = ${organizationId} AND application_id = ANY(${appIds}::uuid[]) ORDER BY field_key, media_id
  `;
  const sharing = contactConsentKey ? rows.filter(r => consents.some(c => c.application_id === r.id && c.consent_key === contactConsentKey)) : [];
  const emails = sharing.length ? await sql<{ application_id: string; email: string | null }[]>`
    SELECT a.id AS application_id, acc.email FROM applications a JOIN accounts acc ON acc.id = a.applicant_account_id
    WHERE a.organization_id = ${organizationId} AND a.id = ANY(${sharing.map(r => r.id)}::uuid[])
  ` : [];
  return rows.map(row => ({
    id: row.id, competitionId: row.competition_id, displayName: row.display_name, status: row.status, answers: row.answers,
    revision: row.revision, waitlistPosition: row.waitlist_position, entryId: row.entry_id,
    submittedAt: row.submitted_at, decidedAt: row.decided_at,
    consents: consents.filter(c => c.application_id === row.id).map(c => ({ key: c.consent_key, version: c.consent_version, acceptedAt: c.accepted_at })),
    media: media.filter(m => m.application_id === row.id).map(m => ({ fieldKey: m.field_key, mediaId: m.media_id })),
    contactEmail: emails.find(e => e.application_id === row.id)?.email ?? null
  }));
}

/** Producer review list. Drafts (never submitted) are private to the applicant and excluded. */
export async function listApplicationsForReview(
  organizationId: string, competitionId: string, options: { status?: string; limit?: number; offset?: number } = {}
): Promise<ReviewView[]> {
  ids(organizationId, competitionId);
  if (options.status !== undefined && (!isApplicationStatus(options.status) || options.status === "draft")) throw new DomainError("invalid_status_filter");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const offset = Math.min(Math.max(Math.trunc(options.offset ?? 0), 0), 100000);
  const sql = getSqlClient();
  const form = await loadForm(sql, organizationId, competitionId);
  const rows = await sql<ApplicationRow[]>`
    SELECT * FROM applications WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}
      AND submitted_at IS NOT NULL ${options.status ? sql`AND status = ${options.status}` : sql``}
    ORDER BY ${options.status === "waitlisted" ? sql`waitlist_position,` : sql``} submitted_at, id
    LIMIT ${limit} OFFSET ${offset}
  `;
  return reviewViews(sql, organizationId, rows, form.contact_consent_key);
}

export async function getApplicationForReview(organizationId: string, competitionId: string, applicationId: string): Promise<ReviewView> {
  ids(organizationId, competitionId, applicationId);
  const sql = getSqlClient();
  const form = await loadForm(sql, organizationId, competitionId);
  const app = await loadApplication(sql, organizationId, competitionId, applicationId, false);
  if (!app.submitted_at) throw new DomainError("application_not_found");
  return (await reviewViews(sql, organizationId, [app], form.contact_consent_key))[0]!;
}

export interface DecisionInput { applicationId: string; status: unknown; reason?: unknown; expectedRevision: unknown; }

function parseDecision(input: DecisionInput): { applicationId: string; status: ApplicationStatus; reason: unknown; expected: number } {
  if (!isUuid(input.applicationId)) throw new DomainError("application_not_found");
  if (!isApplicationStatus(input.status) || input.status === "draft" || input.status === "submitted" || input.status === "withdrawn") {
    throw new DomainError("invalid_decision_status");
  }
  return { applicationId: input.applicationId, status: input.status, reason: input.reason, expected: expectRevision(input.expectedRevision) };
}

/**
 * Producer decisions, individually or in bulk. All-or-nothing: any stale revision
 * (another producer decided first) aborts the whole batch with a 409 conflict.
 */
export async function decideApplications(
  organizationId: string, competitionId: string, actorAccountId: string, decisions: DecisionInput[], now = new Date()
): Promise<ReviewView[]> {
  ids(organizationId, competitionId, actorAccountId);
  if (!Array.isArray(decisions) || decisions.length < 1 || decisions.length > 100) throw new DomainError("invalid_decision_batch");
  const parsed = decisions.map(parseDecision);
  if (new Set(parsed.map(p => p.applicationId)).size !== parsed.length) throw new DomainError("invalid_decision_batch");
  await feature(organizationId, competitionId, actorAccountId);
  const sql = getSqlClient();
  const rows = await sql.begin(async tx => {
    // The form row lock serializes decisions per competition (capacity, waitlist order).
    const form = await loadForm(tx, organizationId, competitionId, true);
    const out: ApplicationRow[] = [];
    for (const decision of parsed) {
      const app = await loadApplication(tx, organizationId, competitionId, decision.applicationId);
      if (app.revision !== decision.expected) throw new DomainError("application_revision_conflict");
      if (app.status === "draft") throw new DomainError("application_not_found");
      const reason = validateReason(decision.reason, decisionRequiresReason(app.status, decision.status));
      out.push(await transition(tx, { organizationId, competitionId, form, app, to: decision.status, actorKind: "producer", actorAccountId, reason, now }));
    }
    return out;
  });
  const form = await loadForm(sql, organizationId, competitionId);
  // Re-read so automatic promotions in the same batch are reflected.
  const fresh = await sql<ApplicationRow[]>`SELECT * FROM applications WHERE organization_id = ${organizationId} AND id = ANY(${rows.map(r => r.id)}::uuid[])`;
  const views = await reviewViews(sql, organizationId, fresh, form.contact_consent_key);
  return rows.map(r => views.find(v => v.id === r.id)!);
}

export async function listApplicationDecisions(organizationId: string, competitionId: string, applicationId: string): Promise<DecisionRecord[]> {
  ids(organizationId, competitionId, applicationId);
  const sql = getSqlClient();
  await loadApplication(sql, organizationId, competitionId, applicationId, false);
  const rows = await sql<{ revision: number; actor_kind: ApplicationActor; actor_account_id: string | null; previous_status: ApplicationStatus; new_status: ApplicationStatus; reason: string | null; decided_at: Date }[]>`
    SELECT revision, actor_kind, actor_account_id, previous_status, new_status, reason, decided_at FROM application_decisions
    WHERE organization_id = ${organizationId} AND application_id = ${applicationId} ORDER BY revision
  `;
  return rows.map(r => ({ revision: r.revision, actorKind: r.actor_kind, actorAccountId: r.actor_account_id, previousStatus: r.previous_status, newStatus: r.new_status, reason: r.reason, decidedAt: r.decided_at }));
}
