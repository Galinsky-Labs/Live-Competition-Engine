import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import {
  FRESH_SESSION_MS,
  isLifecycleAction,
  planLifecycleTransition,
  STEP_UP_TTL_MS,
  tenantAccessError,
  validateAnnouncement,
  validateFraudFlag,
  validateNoteBody,
  validateReason,
  type LifecycleAction,
  type TenantStatus
} from "@live-competition-engine/domain/platform-admin";
import { listAuditEvents, recordAudit, verifyAuditChain, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-53 platform super-admin. Every function here assumes the caller already holds
 * `platform.manage` (checked at the HTTP layer). Destructive tenant actions additionally
 * require a step-up grant bound to the caller's session. Impersonation is NOT provided.
 * All changes are audited on the platform chain (organizationId: null).
 */
export interface PlatformActor {
  accountId: string;
  sessionId: string;
}

// ---------------------------------------------------------------- tenant guard

/**
 * Throw unless the tenant exists and is `active`: tenant_not_found, tenant_suspended,
 * tenant_scheduled_for_deletion or tenant_deleted. Tenant APIs call this before side effects;
 * pass a transaction to evaluate under the caller's snapshot (FOR SHARE blocks a concurrent
 * lifecycle change until the caller commits).
 */
export async function assertTenantActive(organizationId: string, sql: Sql = getSqlClient()): Promise<void> {
  if (!isUuid(organizationId)) throw new DomainError("tenant_not_found");
  const [row] = await sql<{ status: TenantStatus }[]>`SELECT status FROM organizations WHERE id = ${organizationId} FOR SHARE`;
  if (!row) throw new DomainError("tenant_not_found");
  const code = tenantAccessError(row.status);
  if (code) throw new DomainError(code);
}

// ---------------------------------------------------------------- step-up

const stepUpHash = (token: string) => createHash("sha256").update(`step-up\0${token}`, "utf8").digest("hex");
const recoveryHash = (code: string) => createHash("sha256").update(`recovery\0${code}`, "utf8").digest("hex");
const STEP_UP_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface StepUpGrant {
  id: string;
  token: string;
  method: "recovery_code" | "fresh_session";
  expiresAt: Date;
}

async function insertGrant(tx: Sql, actor: PlatformActor, method: StepUpGrant["method"], now: Date): Promise<StepUpGrant> {
  const [session] = await tx<{ id: string }[]>`
    SELECT id FROM auth_sessions
    WHERE id = ${actor.sessionId} AND account_id = ${actor.accountId} AND revoked_at IS NULL AND expires_at > ${now}
  `;
  if (!session) throw new DomainError("step_up_failed");
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + STEP_UP_TTL_MS);
  await tx`
    INSERT INTO step_up_grants (id, account_id, session_id, method, token_hash, created_at, expires_at)
    VALUES (${id}, ${actor.accountId}, ${actor.sessionId}, ${method}, ${stepUpHash(token)}, ${now}, ${expiresAt})
  `;
  await recordAudit(tx, {
    organizationId: null, actorAccountId: actor.accountId, action: "platform.step_up_granted", subjectType: "account",
    subjectId: actor.accountId, details: { method, grantId: id, sessionId: actor.sessionId, expiresAt: expiresAt.toISOString() }
  });
  return { id, token, method, expiresAt };
}

/**
 * Step up by spending one of the caller's own unused recovery codes. Unlike
 * AuthenticationService.recover this does NOT revoke the caller's sessions.
 */
export async function stepUpWithRecoveryCode(actor: PlatformActor, code: unknown, now = new Date()): Promise<StepUpGrant> {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(code)) throw new DomainError("step_up_failed");
  return getSqlClient().begin(async tx => {
    const used = await tx`
      UPDATE account_recovery_codes SET used_at = ${now}
      WHERE account_id = ${actor.accountId} AND code_hash = ${recoveryHash(code)} AND used_at IS NULL AND expires_at > ${now}
      RETURNING id
    `;
    if (used.length !== 1) throw new DomainError("step_up_failed");
    return insertGrant(tx, actor, "recovery_code", now);
  });
}

/**
 * Step up after re-authentication: a session issued within the last 5 minutes (e.g. by
 * AuthenticationService.recover, which consumes a recovery code and rotates sessions).
 */
export async function stepUpWithFreshSession(actor: PlatformActor, now = new Date()): Promise<StepUpGrant> {
  return getSqlClient().begin(async tx => {
    const [session] = await tx<{ created_at: Date }[]>`
      SELECT created_at FROM auth_sessions WHERE id = ${actor.sessionId} AND account_id = ${actor.accountId}
    `;
    if (!session || now.getTime() - session.created_at.getTime() > FRESH_SESSION_MS || session.created_at.getTime() > now.getTime()) {
      throw new DomainError("step_up_failed");
    }
    return insertGrant(tx, actor, "fresh_session", now);
  });
}

/** Resolve a step-up token for this exact account + session; DomainError("step_up_required") otherwise. */
export async function requireStepUp(actor: PlatformActor, token: string | null | undefined, now = new Date(), sql: Sql = getSqlClient()): Promise<string> {
  if (typeof token !== "string" || !STEP_UP_TOKEN.test(token)) throw new DomainError("step_up_required");
  const [grant] = await sql<{ id: string }[]>`
    SELECT g.id FROM step_up_grants g JOIN auth_sessions s ON s.id = g.session_id
    WHERE g.token_hash = ${stepUpHash(token)} AND g.account_id = ${actor.accountId} AND g.session_id = ${actor.sessionId}
      AND g.revoked_at IS NULL AND g.expires_at > ${now} AND s.revoked_at IS NULL AND s.expires_at > ${now}
  `;
  if (!grant) throw new DomainError("step_up_required");
  return grant.id;
}

export async function revokeStepUp(actor: PlatformActor, now = new Date()): Promise<number> {
  const rows = await getSqlClient()`
    UPDATE step_up_grants SET revoked_at = ${now}
    WHERE account_id = ${actor.accountId} AND session_id = ${actor.sessionId} AND revoked_at IS NULL AND expires_at > ${now}
    RETURNING id
  `;
  return rows.length;
}

// ---------------------------------------------------------------- tenant lifecycle

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  statusChangedAt: Date | null;
  deletionScheduledFor: Date | null;
  lifecycleRevision: number;
  createdAt: Date;
  activeMembers: number;
  openFraudFlags: number;
  subscriptionStatus: string | null;
}

interface TenantRow {
  id: string; name: string; slug: string; status: TenantStatus; status_changed_at: Date | null;
  deletion_scheduled_for: Date | null; lifecycle_revision: number; created_at: Date;
  active_members: number; open_flags: number; subscription_status: string | null;
}

const toTenant = (r: TenantRow): TenantSummary => ({
  id: r.id, name: r.name, slug: r.slug, status: r.status, statusChangedAt: r.status_changed_at,
  deletionScheduledFor: r.deletion_scheduled_for, lifecycleRevision: r.lifecycle_revision, createdAt: r.created_at,
  activeMembers: r.active_members, openFraudFlags: r.open_flags, subscriptionStatus: r.subscription_status
});

const TENANT_SELECT = (sql: Sql) => sql`
  SELECT o.id, o.name, o.slug, o.status, o.status_changed_at, o.deletion_scheduled_for, o.lifecycle_revision, o.created_at,
    (SELECT count(*)::int FROM organization_memberships m WHERE m.organization_id = o.id AND m.status = 'active') AS active_members,
    (SELECT count(*)::int FROM platform_fraud_flags f WHERE f.organization_id = o.id AND f.status = 'open') AS open_flags,
    (SELECT s.status FROM tenant_subscriptions s WHERE s.organization_id = o.id
       ORDER BY (s.status <> 'cancelled') DESC, s.created_at DESC LIMIT 1) AS subscription_status
  FROM organizations o
`;

export async function listTenants(filter: { status?: TenantStatus; query?: string; limit?: number; offset?: number } = {}): Promise<TenantSummary[]> {
  const sql = getSqlClient();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.min(Math.max(filter.offset ?? 0, 0), 100_000);
  const q = filter.query?.trim().toLowerCase().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
  const rows = await sql<TenantRow[]>`
    ${TENANT_SELECT(sql)}
    WHERE true
      ${filter.status ? sql`AND o.status = ${filter.status}` : sql``}
      ${pattern ? sql`AND (lower(o.name) LIKE ${pattern} OR o.slug LIKE ${pattern} OR o.id::text = ${q!})` : sql``}
    ORDER BY o.created_at DESC, o.id LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(toTenant);
}

export async function getTenantDetail(organizationId: string) {
  if (!isUuid(organizationId)) return null;
  const sql = getSqlClient();
  const [row] = await sql<TenantRow[]>`${TENANT_SELECT(sql)} WHERE o.id = ${organizationId}`;
  if (!row) return null;
  const [lifecycle, notes, flags] = await Promise.all([
    sql`SELECT id, action, from_status, to_status, reason, actor_account_id, created_at FROM organization_lifecycle_events
        WHERE organization_id = ${organizationId} ORDER BY created_at DESC LIMIT 50`,
    listSupportNotes(organizationId),
    listFraudFlags({ organizationId })
  ]);
  return { tenant: toTenant(row), lifecycle, notes, flags };
}

export interface LifecycleChange {
  action: unknown;
  reason: unknown;
  expectedRevision: unknown;
}

/**
 * Apply a lifecycle action under a row lock with optimistic revision. Destructive actions
 * (suspend, schedule_deletion, finalize_deletion) require a step-up token for this session.
 */
export async function changeTenantLifecycle(
  actor: PlatformActor,
  organizationId: string,
  change: LifecycleChange,
  stepUpToken: string | null,
  now = new Date()
): Promise<TenantSummary> {
  if (!isLifecycleAction(change.action)) throw new DomainError("invalid_lifecycle_action");
  const action: LifecycleAction = change.action;
  const reason = validateReason(change.reason);
  if (!Number.isSafeInteger(change.expectedRevision) || (change.expectedRevision as number) < 0) throw new DomainError("invalid_expected_revision");
  if (!isUuid(organizationId)) throw new DomainError("tenant_not_found");
  return getSqlClient().begin(async tx => {
    const [org] = await tx<{ status: TenantStatus; lifecycle_revision: number; deletion_scheduled_for: Date | null }[]>`
      SELECT status, lifecycle_revision, deletion_scheduled_for FROM organizations WHERE id = ${organizationId} FOR UPDATE
    `;
    if (!org) throw new DomainError("tenant_not_found");
    const plan = planLifecycleTransition(org.status, action, now, org.deletion_scheduled_for);
    const grantId = plan.requiresStepUp ? await requireStepUp(actor, stepUpToken, now, tx) : null;
    if (org.lifecycle_revision !== change.expectedRevision) throw new DomainError("tenant_revision_conflict");
    await tx`
      UPDATE organizations SET status = ${plan.to}, status_changed_at = ${now},
        deletion_scheduled_for = ${plan.deletionScheduledFor}, lifecycle_revision = lifecycle_revision + 1
      WHERE id = ${organizationId}
    `;
    await tx`
      INSERT INTO organization_lifecycle_events (id, organization_id, action, from_status, to_status, reason, actor_account_id, step_up_grant_id, created_at)
      VALUES (${randomUUID()}, ${organizationId}, ${action}, ${plan.from}, ${plan.to}, ${reason}, ${actor.accountId}, ${grantId}, ${now})
    `;
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: `platform.tenant_${action}`, subjectType: "organization",
      subjectId: organizationId, details: {
        from: plan.from, to: plan.to, reason, stepUpGrantId: grantId,
        deletionScheduledFor: plan.deletionScheduledFor?.toISOString() ?? null
      }
    });
    const [row] = await tx<TenantRow[]>`${TENANT_SELECT(tx)} WHERE o.id = ${organizationId}`;
    return toTenant(row!);
  });
}

// ---------------------------------------------------------------- support notes

export interface SupportNote { id: string; organizationId: string; authorAccountId: string; body: string; createdAt: Date }

export async function addSupportNote(actor: PlatformActor, organizationId: string, body: unknown): Promise<SupportNote> {
  const text = validateNoteBody(body);
  if (!isUuid(organizationId)) throw new DomainError("tenant_not_found");
  return getSqlClient().begin(async tx => {
    const [org] = await tx`SELECT id FROM organizations WHERE id = ${organizationId}`;
    if (!org) throw new DomainError("tenant_not_found");
    const id = randomUUID();
    const [row] = await tx<{ created_at: Date }[]>`
      INSERT INTO platform_support_notes (id, organization_id, author_account_id, body)
      VALUES (${id}, ${organizationId}, ${actor.accountId}, ${text}) RETURNING created_at
    `;
    // The note body is kept out of the audit log (it may contain personal data); its hash is recorded.
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: "platform.support_note_added", subjectType: "organization",
      subjectId: organizationId, details: { noteId: id, sha256: createHash("sha256").update(text).digest("hex") }
    });
    return { id, organizationId, authorAccountId: actor.accountId, body: text, createdAt: row!.created_at };
  });
}

export async function listSupportNotes(organizationId: string): Promise<SupportNote[]> {
  const rows = await getSqlClient()<{ id: string; organization_id: string; author_account_id: string; body: string; created_at: Date }[]>`
    SELECT id, organization_id, author_account_id, body, created_at FROM platform_support_notes
    WHERE organization_id = ${organizationId} ORDER BY created_at DESC, id LIMIT 100
  `;
  return rows.map(r => ({ id: r.id, organizationId: r.organization_id, authorAccountId: r.author_account_id, body: r.body, createdAt: r.created_at }));
}

// ---------------------------------------------------------------- fraud flags

export interface FraudFlag {
  id: string; subjectType: "organization" | "account"; organizationId: string | null; accountId: string | null;
  severity: string; reason: string; status: "open" | "resolved"; createdByAccountId: string; createdAt: Date;
  resolvedByAccountId: string | null; resolvedAt: Date | null; resolution: string | null; revision: number;
}

interface FlagRow {
  id: string; subject_type: FraudFlag["subjectType"]; organization_id: string | null; account_id: string | null; severity: string;
  reason: string; status: FraudFlag["status"]; created_by_account_id: string; created_at: Date;
  resolved_by_account_id: string | null; resolved_at: Date | null; resolution: string | null; revision: number;
}

const toFlag = (r: FlagRow): FraudFlag => ({
  id: r.id, subjectType: r.subject_type, organizationId: r.organization_id, accountId: r.account_id, severity: r.severity,
  reason: r.reason, status: r.status, createdByAccountId: r.created_by_account_id, createdAt: r.created_at,
  resolvedByAccountId: r.resolved_by_account_id, resolvedAt: r.resolved_at, resolution: r.resolution, revision: r.revision
});

export async function raiseFraudFlag(actor: PlatformActor, input: unknown): Promise<FraudFlag> {
  const flag = validateFraudFlag(input);
  return getSqlClient().begin(async tx => {
    const [subject] = flag.subjectType === "organization"
      ? await tx`SELECT id FROM organizations WHERE id = ${flag.subjectId}`
      : await tx`SELECT id FROM accounts WHERE id = ${flag.subjectId}`;
    if (!subject) throw new DomainError("flag_subject_not_found");
    const id = randomUUID();
    const [row] = await tx<FlagRow[]>`
      INSERT INTO platform_fraud_flags (id, subject_type, organization_id, account_id, severity, reason, created_by_account_id)
      VALUES (${id}, ${flag.subjectType}, ${flag.subjectType === "organization" ? flag.subjectId : null},
        ${flag.subjectType === "account" ? flag.subjectId : null}, ${flag.severity}, ${flag.reason}, ${actor.accountId})
      RETURNING *
    `;
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: "platform.fraud_flag_raised", subjectType: flag.subjectType,
      subjectId: flag.subjectId, details: { flagId: id, severity: flag.severity }
    });
    return toFlag(row!);
  });
}

export async function resolveFraudFlag(actor: PlatformActor, flagId: string, resolution: unknown, expectedRevision: unknown): Promise<FraudFlag> {
  const text = validateReason(resolution, 2000);
  if (!isUuid(flagId)) throw new DomainError("flag_not_found");
  if (!Number.isSafeInteger(expectedRevision)) throw new DomainError("invalid_expected_revision");
  return getSqlClient().begin(async tx => {
    const [current] = await tx<FlagRow[]>`SELECT * FROM platform_fraud_flags WHERE id = ${flagId} FOR UPDATE`;
    if (!current) throw new DomainError("flag_not_found");
    if (current.status !== "open") throw new DomainError("invalid_state_flag_resolved");
    if (current.revision !== expectedRevision) throw new DomainError("flag_revision_conflict");
    const [row] = await tx<FlagRow[]>`
      UPDATE platform_fraud_flags SET status = 'resolved', resolved_by_account_id = ${actor.accountId}, resolved_at = now(),
        resolution = ${text}, revision = revision + 1
      WHERE id = ${flagId} RETURNING *
    `;
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: "platform.fraud_flag_resolved", subjectType: current.subject_type,
      subjectId: (current.organization_id ?? current.account_id)!, details: { flagId }
    });
    return toFlag(row!);
  });
}

export async function listFraudFlags(filter: { status?: "open" | "resolved"; organizationId?: string; accountId?: string } = {}): Promise<FraudFlag[]> {
  const sql = getSqlClient();
  const rows = await sql<FlagRow[]>`
    SELECT * FROM platform_fraud_flags WHERE true
      ${filter.status ? sql`AND status = ${filter.status}` : sql``}
      ${filter.organizationId ? sql`AND organization_id = ${filter.organizationId}` : sql``}
      ${filter.accountId ? sql`AND account_id = ${filter.accountId}` : sql``}
    ORDER BY created_at DESC, id LIMIT 200
  `;
  return rows.map(toFlag);
}

// ---------------------------------------------------------------- announcements

export interface AnnouncementVersion {
  announcementId: string; version: number; title: string; body: string; severity: string;
  targetOrganizationIds: string[] | null; status: "draft" | "published"; createdAt: Date; publishedAt: Date | null;
}

export interface Announcement {
  id: string; kind: "release_note" | "announcement"; publishedVersion: number | null; withdrawnAt: Date | null;
  createdAt: Date; versions: AnnouncementVersion[];
}

interface VersionRow {
  announcement_id: string; version: number; title: string; body: string; severity: string;
  target_organization_ids: string[] | null; status: "draft" | "published"; created_at: Date; published_at: Date | null;
}

const toVersion = (r: VersionRow): AnnouncementVersion => ({
  announcementId: r.announcement_id, version: r.version, title: r.title, body: r.body, severity: r.severity,
  targetOrganizationIds: r.target_organization_ids, status: r.status, createdAt: r.created_at, publishedAt: r.published_at
});

export async function createAnnouncement(actor: PlatformActor, kind: unknown, input: unknown): Promise<AnnouncementVersion> {
  if (kind !== "release_note" && kind !== "announcement") throw new DomainError("invalid_announcement");
  const content = validateAnnouncement(input);
  return getSqlClient().begin(async tx => {
    const id = randomUUID();
    await tx`INSERT INTO platform_announcements (id, kind, created_by_account_id) VALUES (${id}, ${kind}, ${actor.accountId})`;
    const [row] = await tx<VersionRow[]>`
      INSERT INTO platform_announcement_versions (announcement_id, version, title, body, severity, target_organization_ids, created_by_account_id)
      VALUES (${id}, 1, ${content.title}, ${content.body}, ${content.severity}, ${content.targetOrganizationIds}, ${actor.accountId})
      RETURNING *
    `;
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: "platform.announcement_created", subjectType: "announcement",
      subjectId: id, details: { kind, version: 1 }
    });
    return toVersion(row!);
  });
}

/** Edits never change a version: they add a new draft version. */
export async function addAnnouncementVersion(actor: PlatformActor, announcementId: string, input: unknown): Promise<AnnouncementVersion> {
  const content = validateAnnouncement(input);
  if (!isUuid(announcementId)) throw new DomainError("announcement_not_found");
  return getSqlClient().begin(async tx => {
    const [a] = await tx<{ withdrawn_at: Date | null }[]>`SELECT withdrawn_at FROM platform_announcements WHERE id = ${announcementId} FOR UPDATE`;
    if (!a) throw new DomainError("announcement_not_found");
    if (a.withdrawn_at) throw new DomainError("invalid_state_announcement_withdrawn");
    const [row] = await tx<VersionRow[]>`
      INSERT INTO platform_announcement_versions (announcement_id, version, title, body, severity, target_organization_ids, created_by_account_id)
      SELECT ${announcementId}, COALESCE(MAX(version), 0) + 1, ${content.title}, ${content.body}, ${content.severity},
        ${content.targetOrganizationIds}, ${actor.accountId}
      FROM platform_announcement_versions WHERE announcement_id = ${announcementId}
      RETURNING *
    `;
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: "platform.announcement_versioned", subjectType: "announcement",
      subjectId: announcementId, details: { version: row!.version }
    });
    return toVersion(row!);
  });
}

export async function publishAnnouncementVersion(actor: PlatformActor, announcementId: string, version: unknown): Promise<AnnouncementVersion> {
  if (!isUuid(announcementId)) throw new DomainError("announcement_not_found");
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new DomainError("invalid_announcement_version");
  return getSqlClient().begin(async tx => {
    const [a] = await tx<{ withdrawn_at: Date | null; published_version: number | null }[]>`
      SELECT withdrawn_at, published_version FROM platform_announcements WHERE id = ${announcementId} FOR UPDATE
    `;
    if (!a) throw new DomainError("announcement_not_found");
    if (a.withdrawn_at) throw new DomainError("invalid_state_announcement_withdrawn");
    const [v] = await tx<VersionRow[]>`
      SELECT * FROM platform_announcement_versions WHERE announcement_id = ${announcementId} AND version = ${version as number}
    `;
    if (!v) throw new DomainError("announcement_version_not_found");
    if (v.status === "published") throw new DomainError("invalid_state_version_published");
    if (a.published_version !== null && a.published_version > v.version) throw new DomainError("invalid_state_version_superseded");
    const [row] = await tx<VersionRow[]>`
      UPDATE platform_announcement_versions SET status = 'published', published_at = now(), published_by_account_id = ${actor.accountId}
      WHERE announcement_id = ${announcementId} AND version = ${v.version} RETURNING *
    `;
    await tx`UPDATE platform_announcements SET published_version = ${v.version} WHERE id = ${announcementId}`;
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: "platform.announcement_published", subjectType: "announcement",
      subjectId: announcementId, details: { version: v.version, targets: v.target_organization_ids?.length ?? "all" }
    });
    return toVersion(row!);
  });
}

export async function withdrawAnnouncement(actor: PlatformActor, announcementId: string): Promise<void> {
  if (!isUuid(announcementId)) throw new DomainError("announcement_not_found");
  await getSqlClient().begin(async tx => {
    const rows = await tx`
      UPDATE platform_announcements SET withdrawn_at = now(), withdrawn_by_account_id = ${actor.accountId}
      WHERE id = ${announcementId} AND withdrawn_at IS NULL RETURNING id
    `;
    if (rows.length !== 1) {
      const [exists] = await tx`SELECT 1 FROM platform_announcements WHERE id = ${announcementId}`;
      throw new DomainError(exists ? "invalid_state_announcement_withdrawn" : "announcement_not_found");
    }
    await recordAudit(tx, {
      organizationId: null, actorAccountId: actor.accountId, action: "platform.announcement_withdrawn", subjectType: "announcement", subjectId: announcementId
    });
  });
}

export async function listAnnouncements(limit = 50): Promise<Announcement[]> {
  const sql = getSqlClient();
  const announcements = await sql<{ id: string; kind: Announcement["kind"]; published_version: number | null; withdrawn_at: Date | null; created_at: Date }[]>`
    SELECT id, kind, published_version, withdrawn_at, created_at FROM platform_announcements
    ORDER BY created_at DESC, id LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `;
  if (announcements.length === 0) return [];
  const versions = await sql<VersionRow[]>`
    SELECT * FROM platform_announcement_versions WHERE announcement_id = ANY(${announcements.map(a => a.id)}::uuid[])
    ORDER BY version DESC
  `;
  return announcements.map(a => ({
    id: a.id, kind: a.kind, publishedVersion: a.published_version, withdrawnAt: a.withdrawn_at, createdAt: a.created_at,
    versions: versions.filter(v => v.announcement_id === a.id).map(toVersion)
  }));
}

/** Tenant view: the currently published version of each non-withdrawn announcement targeting this tenant. */
export async function listTenantAnnouncements(organizationId: string): Promise<Array<{ id: string; kind: string; version: number; title: string; body: string; severity: string; publishedAt: Date }>> {
  const rows = await getSqlClient()<{ id: string; kind: string; version: number; title: string; body: string; severity: string; published_at: Date }[]>`
    SELECT a.id, a.kind, v.version, v.title, v.body, v.severity, v.published_at
    FROM platform_announcements a
    JOIN platform_announcement_versions v ON v.announcement_id = a.id AND v.version = a.published_version
    WHERE a.withdrawn_at IS NULL AND v.status = 'published'
      AND (v.target_organization_ids IS NULL OR ${organizationId}::uuid = ANY(v.target_organization_ids))
    ORDER BY v.published_at DESC LIMIT 50
  `;
  return rows.map(r => ({ id: r.id, kind: r.kind, version: r.version, title: r.title, body: r.body, severity: r.severity, publishedAt: r.published_at }));
}

// ---------------------------------------------------------------- audit

export async function platformAudit(options: { limit?: number; beforeSequence?: number } = {}) {
  const [events, verification] = await Promise.all([listAuditEvents(null, options), verifyAuditChain(null)]);
  return { events, verification };
}
