import {
  ProfileService,
  projectProfile,
  type ProfilePatch,
  type ProfileRecord,
  type ProfileRole,
  type ProfileStore,
  type ProfileView,
  type ProfileViewer,
  type PublicHistoryItem
} from "@live-competition-engine/profiles";
import { DomainError, isBoundedText, isUuid } from "@live-competition-engine/domain";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-10 PostgreSQL profile storage. The pure projection/edit rules live in
 * @live-competition-engine/profiles; this module adds tenant-scoped storage,
 * derived linked history, moderation and audit.
 */
interface ProfileRow {
  id: string;
  organization_id: string;
  owner_account_id: string;
  revision: number;
  display_name: string;
  bio: string;
  roles: ProfileRole[];
  visibility: ProfileRecord["visibility"];
  hidden_at: Date | null;
  owner_active: boolean;
}

export interface StoredProfile {
  record: ProfileRecord;
  hidden: boolean;
  ownerActive: boolean;
}

/**
 * Linked history: events where an entry of a participant linked to the owner
 * account has a FINAL result, and the event is no longer a draft or cancelled.
 * Only events whose visibility is `public` are flagged public; the projection drops
 * the rest (including for the owner).
 */
async function loadHistory(sql: Sql, organizationId: string, accountId: string): Promise<PublicHistoryItem[]> {
  const rows = await sql<{ id: string; title: string; is_public: boolean }[]>`
    SELECT c.id, c.title, (c.visibility = 'public') AS is_public
    FROM competitions c
    WHERE c.organization_id = ${organizationId}
      AND c.status IN ('published', 'live', 'paused', 'completed')
      AND EXISTS (
        SELECT 1 FROM results r
        JOIN entries e ON e.organization_id = r.organization_id AND e.id = r.entry_id
        JOIN participants p ON p.organization_id = e.organization_id AND p.id = e.participant_id
        WHERE r.organization_id = c.organization_id AND r.competition_id = c.id
          AND r.status = 'final' AND p.account_id = ${accountId}
      )
    ORDER BY c.starts_at DESC NULLS LAST, c.created_at DESC, c.id
    LIMIT 100
  `;
  return rows.map(row => ({ eventId: row.id, title: row.title.slice(0, 200), public: row.is_public }));
}

async function loadProfile(sql: Sql, organizationId: string, profileId: string): Promise<StoredProfile | null> {
  if (!isUuid(organizationId) || !isUuid(profileId)) return null;
  const [row] = await sql<ProfileRow[]>`
    SELECT p.id, p.organization_id, p.owner_account_id, p.revision, p.display_name, p.bio, p.roles,
      p.visibility, p.hidden_at, (m.status = 'active') AS owner_active
    FROM profiles p
    JOIN organization_memberships m ON m.organization_id = p.organization_id AND m.account_id = p.owner_account_id
    WHERE p.organization_id = ${organizationId} AND p.id = ${profileId}
  `;
  if (!row) return null;
  return {
    record: {
      id: row.id,
      organizationId: row.organization_id,
      ownerAccountId: row.owner_account_id,
      revision: row.revision,
      displayName: row.display_name,
      bio: row.bio,
      roles: row.roles,
      visibility: row.visibility,
      history: await loadHistory(sql, organizationId, row.owner_account_id)
    },
    hidden: row.hidden_at !== null,
    ownerActive: row.owner_active
  };
}

/** ProfileStore with an atomic tenant/id/owner/revision compare-and-set and audit in one transaction. */
export function createPostgresProfileStore(sql = getSqlClient()): ProfileStore {
  return {
    async find(organizationId, profileId) {
      return (await loadProfile(sql, organizationId, profileId))?.record ?? null;
    },
    async compareAndSet(profile, expectedRevision) {
      try {
        return await sql.begin(async tx => {
          const rows = expectedRevision === null
            ? await tx`
                INSERT INTO profiles (id, organization_id, owner_account_id, revision, display_name, bio, roles, visibility)
                VALUES (${profile.id}, ${profile.organizationId}, ${profile.ownerAccountId}, ${profile.revision},
                  ${profile.displayName}, ${profile.bio}, ${[...profile.roles]}::text[], ${profile.visibility})
                ON CONFLICT DO NOTHING
                RETURNING id
              `
            : await tx`
                UPDATE profiles SET revision = ${profile.revision}, display_name = ${profile.displayName},
                  bio = ${profile.bio}, roles = ${[...profile.roles]}::text[], visibility = ${profile.visibility},
                  updated_at = now()
                WHERE organization_id = ${profile.organizationId} AND id = ${profile.id}
                  AND owner_account_id = ${profile.ownerAccountId} AND revision = ${expectedRevision}
                RETURNING id
              `;
          if (rows.length !== 1) return false;
          await recordAudit(tx, {
            organizationId: profile.organizationId,
            actorAccountId: profile.ownerAccountId,
            action: expectedRevision === null ? "profile.created" : "profile.updated",
            subjectType: "profile",
            subjectId: profile.id,
            details: { revision: profile.revision, visibility: profile.visibility, roles: [...profile.roles] }
          });
          return true;
        });
      } catch (error) {
        // Trigger: owner is not (or no longer) an active member.
        if ((error as { code?: string }).code === "23514" || (error as { code?: string }).code === "23503") {
          throw new DomainError("forbidden");
        }
        throw error;
      }
    }
  };
}

function viewerFor(organizationId: string, accountId: string | null): ProfileViewer | null {
  return accountId ? { organizationId, accountId } : null;
}

/**
 * Read a profile for a viewer (null = anonymous). Hidden profiles and profiles of
 * suspended members are visible only to their owner.
 */
export async function readProfile(
  organizationId: string,
  profileId: string,
  viewerAccountId: string | null
): Promise<(ProfileView & { hidden: boolean }) | null> {
  const stored = await loadProfile(getSqlClient(), organizationId, profileId);
  if (!stored) return null;
  const isOwner = viewerAccountId !== null && viewerAccountId === stored.record.ownerAccountId;
  if ((stored.hidden || !stored.ownerActive) && !isOwner) return null;
  const view = projectProfile(stored.record, organizationId, viewerFor(organizationId, viewerAccountId));
  return view ? { ...view, hidden: stored.hidden } : null;
}

const PATCH_KEYS = ["bio", "displayName", "roles", "visibility"];

/** Validate an untrusted JSON patch into exactly the editable fields. */
export function parseProfilePatch(body: Record<string, unknown>): ProfilePatch {
  if (Object.keys(body).sort().join(",") !== PATCH_KEYS.join(",")) throw new DomainError("invalid_profile");
  const { displayName, bio, roles, visibility } = body;
  if (!isBoundedText(displayName, 100) || !displayName.trim() || !isBoundedText(bio, 2000) ||
    !Array.isArray(roles) || roles.length > 3 || new Set(roles).size !== roles.length ||
    !roles.every(role => role === "performer" || role === "producer" || role === "judge") ||
    (visibility !== "public" && visibility !== "members" && visibility !== "private")) {
    throw new DomainError("invalid_profile");
  }
  return { displayName, bio, roles: roles as ProfileRole[], visibility };
}

/** Owner-only create/update with compare-and-set. accountId is the authenticated principal. */
export async function editProfile(
  organizationId: string,
  profileId: string,
  accountId: string,
  patch: ProfilePatch,
  expectedRevision: number | null
): Promise<ProfileView> {
  const store = createPostgresProfileStore();
  const service = new ProfileService(store);
  if (expectedRevision !== null && isUuid(organizationId) && isUuid(profileId) &&
    !(await store.find(organizationId, profileId))) {
    throw new DomainError("profile_not_found");
  }
  try {
    return await service.edit(organizationId, profileId, { organizationId, accountId }, patch, expectedRevision);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    const message = (error as Error).message;
    if (message === "Profile revision conflict.") throw new DomainError("profile_revision_conflict");
    if (message === "Profile edit denied.") throw new DomainError("forbidden");
    if (message === "Invalid profile." || message === "Invalid profile patch.") throw new DomainError("invalid_profile");
    throw error;
  }
}

export interface ProfileSummary {
  id: string;
  displayName: string;
  roles: ProfileRole[];
}

/** Keyset-paginated list of profiles visible to the viewer (null = anonymous: public only). */
export async function listProfiles(
  organizationId: string,
  viewerAccountId: string | null,
  options: { limit?: number; after?: string } = {}
): Promise<{ profiles: ProfileSummary[]; next: string | null }> {
  if (!isUuid(organizationId)) return { profiles: [], next: null };
  if (options.after !== undefined && !isUuid(options.after)) throw new DomainError("invalid_cursor");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const sql = getSqlClient();
  const rows = await sql<{ id: string; display_name: string; roles: ProfileRole[] }[]>`
    SELECT p.id, p.display_name, p.roles
    FROM profiles p
    JOIN organization_memberships m ON m.organization_id = p.organization_id AND m.account_id = p.owner_account_id
    WHERE p.organization_id = ${organizationId} AND p.hidden_at IS NULL AND m.status = 'active'
      AND (p.visibility = 'public'
        ${viewerAccountId ? sql`OR p.visibility = 'members' OR p.owner_account_id = ${viewerAccountId}` : sql``})
      ${options.after ? sql`AND p.id > ${options.after}` : sql``}
    ORDER BY p.id
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  return {
    profiles: page.map(row => ({ id: row.id, displayName: row.display_name, roles: row.roles })),
    next: rows.length > limit ? page[page.length - 1]!.id : null
  };
}

/** Operator moderation (tenant.manage): hide or restore a profile. Audited. */
export async function moderateProfile(
  organizationId: string,
  profileId: string,
  actorAccountId: string,
  input: { hidden: boolean; reason?: string }
): Promise<{ id: string; hidden: boolean }> {
  if (!isUuid(organizationId) || !isUuid(profileId)) throw new DomainError("profile_not_found");
  if (input.reason !== undefined && !isBoundedText(input.reason, 500)) throw new DomainError("invalid_reason");
  return getSqlClient().begin(async tx => {
    const rows = await tx<{ id: string }[]>`
      UPDATE profiles SET
        hidden_at = ${input.hidden ? tx`now()` : null},
        hidden_by_account_id = ${input.hidden ? actorAccountId : null},
        hidden_reason = ${input.hidden ? input.reason ?? null : null}
      WHERE organization_id = ${organizationId} AND id = ${profileId}
      RETURNING id
    `;
    if (rows.length !== 1) throw new DomainError("profile_not_found");
    await recordAudit(tx, {
      organizationId,
      actorAccountId,
      action: input.hidden ? "profile.hidden" : "profile.restored",
      subjectType: "profile",
      subjectId: profileId,
      details: input.reason ? { reason: input.reason } : {}
    });
    return { id: profileId, hidden: input.hidden };
  });
}

/**
 * Link a participant record to a member account (tenant.manage) so the member's
 * profile shows linked history. Pass null to unlink. Audited.
 */
export async function linkParticipantAccount(
  organizationId: string,
  participantId: string,
  accountId: string | null,
  actorAccountId: string
): Promise<{ participantId: string; accountId: string | null }> {
  if (!isUuid(organizationId) || !isUuid(participantId)) throw new DomainError("participant_not_found");
  if (accountId !== null && !isUuid(accountId)) throw new DomainError("invalid_account");
  return getSqlClient().begin(async tx => {
    if (accountId !== null) {
      const [member] = await tx`
        SELECT 1 FROM organization_memberships
        WHERE organization_id = ${organizationId} AND account_id = ${accountId} AND status = 'active'
      `;
      if (!member) throw new DomainError("member_not_found");
    }
    const rows = await tx`
      UPDATE participants SET account_id = ${accountId}
      WHERE organization_id = ${organizationId} AND id = ${participantId}
      RETURNING id
    `;
    if (rows.length !== 1) throw new DomainError("participant_not_found");
    await recordAudit(tx, {
      organizationId,
      actorAccountId,
      action: accountId ? "participant.account_linked" : "participant.account_unlinked",
      subjectType: "participant",
      subjectId: participantId,
      details: { accountId }
    });
    return { participantId, accountId };
  });
}
