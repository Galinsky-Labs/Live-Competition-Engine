import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "@live-competition-engine/domain";
import {
  invitationExpiry,
  normalizeEmail,
  parseInvitationRole,
  parseRoleGrantRequest,
  parseVenueInput,
  type InvitationRole
} from "@live-competition-engine/domain/tenant-admin";
import { recordAudit } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-43 tenant administration service. Every function takes the tenant id first and
 * filters by it. Callers (HTTP handlers) must have authorized `tenant.manage` in that tenant,
 * except acceptInvitation which is called by the invited, authenticated account.
 */

const hashInvitationToken = (token: string) =>
  createHash("sha256").update(`invitation\0${token}`, "utf8").digest("hex");

export interface InvitationCreated {
  id: string;
  email: string;
  initialRole: InvitationRole | null;
  expiresAt: Date;
  /** Returned exactly once; only its SHA-256 hash is stored. */
  token: string;
}

export async function createInvitation(
  organizationId: string,
  actorAccountId: string,
  input: { email: unknown; initialRole?: unknown; ttlMs?: unknown },
  now = new Date()
): Promise<InvitationCreated> {
  const email = normalizeEmail(input.email);
  const initialRole = parseInvitationRole(input.initialRole);
  const expiresAt = invitationExpiry(now, input.ttlMs);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  return getSqlClient().begin(async tx => {
    const org = await tx`SELECT 1 FROM organizations WHERE id = ${organizationId}`;
    if (org.length !== 1) throw new DomainError("organization_not_found");
    const member = await tx`
      SELECT 1 FROM organization_memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.organization_id = ${organizationId} AND a.email = ${email}
    `;
    if (member.length > 0) throw new DomainError("invitation_conflict_already_member");
    // Re-inviting replaces the previous pending invitation (its token stops working).
    await tx`
      UPDATE organization_invitations SET status = 'revoked', revoked_at = ${now}
      WHERE organization_id = ${organizationId} AND email = ${email} AND status = 'pending'
    `;
    await tx`
      INSERT INTO organization_invitations (id, organization_id, email, initial_role, token_hash,
        invited_by_account_id, expires_at, created_at)
      VALUES (${id}, ${organizationId}, ${email}, ${initialRole}, ${hashInvitationToken(token)},
        ${actorAccountId}, ${expiresAt}, ${now})
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "tenant.invitation_created",
      subjectType: "organization_invitation", subjectId: id,
      details: { initialRole, expiresAt: expiresAt.toISOString() }
    });
    return { id, email, initialRole, expiresAt, token };
  });
}

export async function revokeInvitation(organizationId: string, actorAccountId: string, invitationId: string, now = new Date()): Promise<void> {
  await getSqlClient().begin(async tx => {
    const rows = await tx`
      UPDATE organization_invitations SET status = 'revoked', revoked_at = ${now}
      WHERE id = ${invitationId} AND organization_id = ${organizationId} AND status = 'pending'
      RETURNING id
    `;
    if (rows.length !== 1) throw new DomainError("invitation_not_found");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "tenant.invitation_revoked",
      subjectType: "organization_invitation", subjectId: invitationId
    });
  });
}

export async function listInvitations(organizationId: string) {
  const rows = await getSqlClient()<{
    id: string; email: string; initial_role: string | null; status: string; expires_at: Date; created_at: Date;
  }[]>`
    SELECT id, email, initial_role, status, expires_at, created_at FROM organization_invitations
    WHERE organization_id = ${organizationId} ORDER BY created_at DESC LIMIT 200
  `;
  return rows.map(row => ({
    id: row.id, email: row.email, initialRole: row.initial_role, status: row.status,
    expiresAt: row.expires_at, createdAt: row.created_at
  }));
}

/**
 * Accept an invitation as the authenticated account. Single use: the pending row is
 * locked and flipped to accepted atomically. The account's verified email must match.
 */
export async function acceptInvitation(
  organizationId: string,
  accountId: string,
  token: unknown,
  now = new Date()
): Promise<{ membershipCreated: boolean; roleGrantId: string | null }> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError("invitation_not_found");
  return getSqlClient().begin(async tx => {
    const [invite] = await tx<{ id: string; email: string; initial_role: InvitationRole | null; status: string; expires_at: Date }[]>`
      SELECT id, email, initial_role, status, expires_at FROM organization_invitations
      WHERE organization_id = ${organizationId} AND token_hash = ${hashInvitationToken(token)}
      FOR UPDATE
    `;
    if (!invite || invite.status !== "pending") throw new DomainError("invitation_not_found");
    if (invite.expires_at.getTime() <= now.getTime()) throw new DomainError("invitation_expired");
    const [account] = await tx<{ email: string | null }[]>`
      SELECT email FROM accounts WHERE id = ${accountId} AND disabled_at IS NULL
    `;
    if (!account || account.email !== invite.email) throw new DomainError("forbidden");
    const [existing] = await tx<{ status: string }[]>`
      SELECT status FROM organization_memberships
      WHERE organization_id = ${organizationId} AND account_id = ${accountId} FOR UPDATE
    `;
    if (existing?.status === "suspended") throw new DomainError("invalid_state_membership_suspended");
    let membershipCreated = false;
    if (!existing) {
      await tx`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${organizationId}, ${accountId})`;
      membershipCreated = true;
    }
    let roleGrantId: string | null = null;
    if (invite.initial_role) {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO role_grants (account_id, role, organization_id, granted_by_account_id)
        SELECT ${accountId}, ${invite.initial_role}, ${organizationId}, invited_by_account_id
        FROM organization_invitations WHERE id = ${invite.id}
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      roleGrantId = inserted[0]?.id ?? null;
    }
    await tx`
      UPDATE organization_invitations SET status = 'accepted', accepted_at = ${now}, accepted_by_account_id = ${accountId}
      WHERE id = ${invite.id} AND status = 'pending'
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId: accountId, action: "tenant.invitation_accepted",
      subjectType: "organization_invitation", subjectId: invite.id,
      details: { membershipCreated, roleGrantId }
    });
    return { membershipCreated, roleGrantId };
  });
}

export interface MemberSummary {
  accountId: string;
  email: string | null;
  status: "active" | "suspended";
  joinedAt: Date;
  suspendedAt: Date | null;
  grants: Array<{ id: string; role: string; competitionId: string | null; grantedAt: Date; expiresAt: Date | null }>;
}

export async function listMembers(organizationId: string, options: { limit?: number; offset?: number } = {}): Promise<MemberSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const sql = getSqlClient();
  const members = await sql<{ account_id: string; email: string | null; status: "active" | "suspended"; created_at: Date; suspended_at: Date | null }[]>`
    SELECT m.account_id, a.email, m.status, m.created_at, m.suspended_at
    FROM organization_memberships m JOIN accounts a ON a.id = m.account_id
    WHERE m.organization_id = ${organizationId}
    ORDER BY m.created_at, m.account_id LIMIT ${limit} OFFSET ${offset}
  `;
  if (members.length === 0) return [];
  const grants = await sql<{ id: string; account_id: string; role: string; competition_id: string | null; granted_at: Date; expires_at: Date | null }[]>`
    SELECT id, account_id, role::text AS role, competition_id, granted_at, expires_at FROM role_grants
    WHERE organization_id = ${organizationId} AND revoked_at IS NULL
      AND account_id IN ${sql(members.map(member => member.account_id))}
    ORDER BY granted_at
  `;
  return members.map(member => ({
    accountId: member.account_id,
    email: member.email,
    status: member.status,
    joinedAt: member.created_at,
    suspendedAt: member.suspended_at,
    grants: grants.filter(grant => grant.account_id === member.account_id).map(grant => ({
      id: grant.id, role: grant.role, competitionId: grant.competition_id, grantedAt: grant.granted_at, expiresAt: grant.expires_at
    }))
  }));
}

export async function setMembershipStatus(
  organizationId: string,
  actorAccountId: string,
  accountId: string,
  status: "active" | "suspended",
  now = new Date()
): Promise<void> {
  if (status !== "active" && status !== "suspended") throw new DomainError("invalid_membership_status");
  if (accountId === actorAccountId) throw new DomainError("cannot_change_own_membership");
  await getSqlClient().begin(async tx => {
    const [row] = await tx<{ status: "active" | "suspended" }[]>`
      SELECT status FROM organization_memberships
      WHERE organization_id = ${organizationId} AND account_id = ${accountId} FOR UPDATE
    `;
    if (!row) throw new DomainError("member_not_found");
    if (row.status === status) throw new DomainError(`invalid_state_membership_already_${status}`);
    await tx`
      UPDATE organization_memberships
      SET status = ${status}, suspended_at = ${status === "suspended" ? now : null}
      WHERE organization_id = ${organizationId} AND account_id = ${accountId}
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId,
      action: status === "suspended" ? "tenant.member_suspended" : "tenant.member_reactivated",
      subjectType: "account", subjectId: accountId
    });
  });
}

export async function grantTenantRole(
  organizationId: string,
  actorAccountId: string,
  accountId: string,
  input: { role?: unknown; competitionId?: unknown; expiresAt?: unknown },
  now = new Date()
): Promise<{ id: string }> {
  const request = parseRoleGrantRequest(input);
  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    expiresAt = typeof input.expiresAt === "string" ? new Date(input.expiresAt) : new Date(NaN);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) throw new DomainError("invalid_grant_expiry");
  }
  return getSqlClient().begin(async tx => {
    const member = await tx`
      SELECT 1 FROM organization_memberships
      WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND status = 'active'
      FOR SHARE
    `;
    if (member.length !== 1) throw new DomainError("member_not_found");
    if (request.competitionId) {
      const competition = await tx`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${request.competitionId}`;
      if (competition.length !== 1) throw new DomainError("competition_not_found");
    }
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO role_grants (account_id, role, organization_id, competition_id, granted_by_account_id, granted_at, expires_at)
      VALUES (${accountId}, ${request.role}, ${organizationId}, ${request.competitionId}, ${actorAccountId}, ${now}, ${expiresAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    if (inserted.length !== 1) throw new DomainError("role_grant_conflict");
    const id = inserted[0]!.id;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "tenant.role_granted", subjectType: "role_grant", subjectId: id,
      details: { accountId, role: request.role, competitionId: request.competitionId }
    });
    return { id };
  });
}

/** Revoke preserves the grant row (revoked_at set); history stays queryable. */
export async function revokeTenantRole(organizationId: string, actorAccountId: string, grantId: string, now = new Date()): Promise<void> {
  await getSqlClient().begin(async tx => {
    const [grant] = await tx<{ account_id: string; role: string; revoked_at: Date | null }[]>`
      SELECT account_id, role::text AS role, revoked_at FROM role_grants
      WHERE id = ${grantId} AND organization_id = ${organizationId} FOR UPDATE
    `;
    if (!grant || grant.role === "platform_operator") throw new DomainError("role_grant_not_found");
    if (grant.revoked_at) throw new DomainError("invalid_state_role_grant_revoked");
    if (grant.account_id === actorAccountId && grant.role === "tenant_operator") {
      throw new DomainError("cannot_revoke_own_operator_grant");
    }
    await tx`UPDATE role_grants SET revoked_at = ${now} WHERE id = ${grantId} AND organization_id = ${organizationId}`;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "tenant.role_revoked", subjectType: "role_grant", subjectId: grantId,
      details: { accountId: grant.account_id, role: grant.role }
    });
  });
}

export interface Venue {
  id: string;
  name: string;
  address: string | null;
  capacity: number | null;
  timezone: string | null;
  revision: number;
  archivedAt: Date | null;
}

type VenueRow = { id: string; name: string; address: string | null; capacity: number | null; timezone: string | null; revision: number; archived_at: Date | null };
const toVenue = (row: VenueRow): Venue => ({
  id: row.id, name: row.name, address: row.address, capacity: row.capacity, timezone: row.timezone,
  revision: row.revision, archivedAt: row.archived_at
});

function uniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23505";
}

export async function createVenue(organizationId: string, actorAccountId: string, input: Record<string, unknown>): Promise<Venue> {
  const venue = parseVenueInput(input);
  try {
    return await getSqlClient().begin(async tx => {
      const [row] = await tx<VenueRow[]>`
        INSERT INTO venues (organization_id, name, address, capacity, timezone, created_by_account_id)
        VALUES (${organizationId}, ${venue.name}, ${venue.address}, ${venue.capacity}, ${venue.timezone}, ${actorAccountId})
        RETURNING id, name, address, capacity, timezone, revision, archived_at
      `;
      await recordAudit(tx, { organizationId, actorAccountId, action: "tenant.venue_created", subjectType: "venue", subjectId: row!.id });
      return toVenue(row!);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new DomainError("venue_name_conflict");
    throw error;
  }
}

export async function updateVenue(
  organizationId: string, actorAccountId: string, venueId: string, input: Record<string, unknown>
): Promise<Venue> {
  const venue = parseVenueInput(input);
  const expected = input.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1) throw new DomainError("invalid_expected_revision");
  try {
    return await getSqlClient().begin(async tx => {
      const [row] = await tx<VenueRow[]>`
        UPDATE venues SET name = ${venue.name}, address = ${venue.address}, capacity = ${venue.capacity},
          timezone = ${venue.timezone}, revision = revision + 1, updated_at = now()
        WHERE organization_id = ${organizationId} AND id = ${venueId} AND archived_at IS NULL AND revision = ${expected}
        RETURNING id, name, address, capacity, timezone, revision, archived_at
      `;
      if (!row) {
        const exists = await tx`SELECT 1 FROM venues WHERE organization_id = ${organizationId} AND id = ${venueId} AND archived_at IS NULL`;
        throw new DomainError(exists.length ? "venue_revision_conflict" : "venue_not_found");
      }
      await recordAudit(tx, { organizationId, actorAccountId, action: "tenant.venue_updated", subjectType: "venue", subjectId: venueId, details: { revision: row.revision } });
      return toVenue(row);
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new DomainError("venue_name_conflict");
    throw error;
  }
}

/** Venues are archived rather than deleted so past events keep their reference. */
export async function archiveVenue(organizationId: string, actorAccountId: string, venueId: string): Promise<void> {
  await getSqlClient().begin(async tx => {
    const rows = await tx`
      UPDATE venues SET archived_at = now(), revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${venueId} AND archived_at IS NULL RETURNING id
    `;
    if (rows.length !== 1) throw new DomainError("venue_not_found");
    await recordAudit(tx, { organizationId, actorAccountId, action: "tenant.venue_archived", subjectType: "venue", subjectId: venueId });
  });
}

export async function listVenues(organizationId: string, includeArchived = false): Promise<Venue[]> {
  const sql = getSqlClient();
  const rows = await sql<VenueRow[]>`
    SELECT id, name, address, capacity, timezone, revision, archived_at FROM venues
    WHERE organization_id = ${organizationId} ${includeArchived ? sql`` : sql`AND archived_at IS NULL`}
    ORDER BY lower(name) LIMIT 500
  `;
  return rows.map(toVenue);
}

export async function getVenue(organizationId: string, venueId: string): Promise<Venue | null> {
  const [row] = await getSqlClient()<VenueRow[]>`
    SELECT id, name, address, capacity, timezone, revision, archived_at FROM venues
    WHERE organization_id = ${organizationId} AND id = ${venueId}
  `;
  return row ? toVenue(row) : null;
}

/** Attach an event (competition) to an active venue of the same tenant. */
export async function assignCompetitionVenue(
  organizationId: string, actorAccountId: string, competitionId: string, venueId: string | null
): Promise<void> {
  await getSqlClient().begin(async tx => {
    const competition = await tx`SELECT 1 FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId} FOR UPDATE`;
    if (competition.length !== 1) throw new DomainError("competition_not_found");
    if (venueId === null) {
      await tx`DELETE FROM competition_venues WHERE organization_id = ${organizationId} AND competition_id = ${competitionId}`;
    } else {
      const venue = await tx`SELECT 1 FROM venues WHERE organization_id = ${organizationId} AND id = ${venueId} AND archived_at IS NULL FOR SHARE`;
      if (venue.length !== 1) throw new DomainError("venue_not_found");
      await tx`
        INSERT INTO competition_venues (organization_id, competition_id, venue_id) VALUES (${organizationId}, ${competitionId}, ${venueId})
        ON CONFLICT (organization_id, competition_id) DO UPDATE SET venue_id = EXCLUDED.venue_id, assigned_at = now()
      `;
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "tenant.competition_venue_assigned", subjectType: "competition", subjectId: competitionId, details: { venueId } });
  });
}

export interface ShowOverview {
  statusCounts: Record<string, number>;
  competitions: Array<{ id: string; title: string; status: string; startsAt: Date | null; venueId: string | null; venueName: string | null; entryCount: number }>;
}

export async function showOverview(organizationId: string, limit = 100): Promise<ShowOverview> {
  const sql = getSqlClient();
  const counts = await sql<{ status: string; count: number }[]>`
    SELECT status::text AS status, count(*)::int AS count FROM competitions
    WHERE organization_id = ${organizationId} GROUP BY status
  `;
  const rows = await sql<{ id: string; title: string; status: string; starts_at: Date | null; venue_id: string | null; venue_name: string | null; entry_count: number }[]>`
    SELECT c.id, c.title, c.status::text AS status, c.starts_at, cv.venue_id, v.name AS venue_name,
      (SELECT count(*)::int FROM entries e WHERE e.organization_id = c.organization_id AND e.competition_id = c.id) AS entry_count
    FROM competitions c
    LEFT JOIN competition_venues cv ON cv.organization_id = c.organization_id AND cv.competition_id = c.id
    LEFT JOIN venues v ON v.organization_id = cv.organization_id AND v.id = cv.venue_id
    WHERE c.organization_id = ${organizationId}
    ORDER BY c.starts_at DESC NULLS LAST, c.created_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
  const statusCounts: Record<string, number> = { draft: 0, published: 0, live: 0, paused: 0, completed: 0, cancelled: 0 };
  for (const row of counts) statusCounts[row.status] = row.count;
  return {
    statusCounts,
    competitions: rows.map(row => ({
      id: row.id, title: row.title, status: row.status, startsAt: row.starts_at,
      venueId: row.venue_id, venueName: row.venue_name, entryCount: row.entry_count
    }))
  };
}
