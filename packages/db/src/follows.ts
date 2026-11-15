import { DomainError, isUuid } from "@live-competition-engine/domain";
import { recordAudit, type Sql } from "./audit.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-12 follows and audience relationships. Members follow profiles, events
 * (competitions) or the tenant. Follower identities are never exposed through
 * public or member APIs; only counts are. Notification consent is a separate,
 * explicit, timestamped and audited opt-in per follow.
 */
export type FollowTargetType = "profile" | "competition" | "organization";
export interface FollowTarget {
  type: FollowTargetType;
  id: string;
}

export interface FollowRecord {
  id: string;
  targetType: FollowTargetType;
  targetId: string;
  notifyConsent: boolean;
  notifyConsentAt: Date | null;
  createdAt: Date;
}

export function parseFollowTarget(input: { targetType?: unknown; targetId?: unknown }): FollowTarget {
  const { targetType, targetId } = input;
  if ((targetType !== "profile" && targetType !== "competition" && targetType !== "organization") || !isUuid(targetId)) {
    throw new DomainError("invalid_follow_target");
  }
  return { type: targetType, id: targetId.toLowerCase() };
}

/**
 * Is the target visible to the viewer (null = anonymous)? Profiles: not hidden,
 * active owner, public (or members-only for members, or own). Events: not drafts.
 */
async function targetVisible(sql: Sql, organizationId: string, target: FollowTarget, viewerAccountId: string | null): Promise<boolean> {
  if (target.type === "organization") return target.id === organizationId;
  if (target.type === "profile") {
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT (p.visibility = 'public'
        OR (p.visibility = 'members' AND ${viewerAccountId !== null})
        OR p.owner_account_id = ${viewerAccountId ?? "00000000-0000-0000-0000-000000000000"}) AS ok
      FROM profiles p
      JOIN organization_memberships m ON m.organization_id = p.organization_id AND m.account_id = p.owner_account_id
      WHERE p.organization_id = ${organizationId} AND p.id = ${target.id} AND p.hidden_at IS NULL AND m.status = 'active'
    `;
    return row?.ok === true;
  }
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT true AS ok
    FROM competitions c
    WHERE c.organization_id = ${organizationId} AND c.id = ${target.id} AND c.status <> 'draft'
  `;
  return row?.ok === true;
}

const targetColumns = (target: FollowTarget) => ({
  profile_id: target.type === "profile" ? target.id : null,
  competition_id: target.type === "competition" ? target.id : null
});

function toRecord(row: {
  id: string; target_type: FollowTargetType; target_id: string; notify_consent: boolean;
  notify_consent_at: Date | null; created_at: Date;
}): FollowRecord {
  return {
    id: row.id, targetType: row.target_type, targetId: row.target_id, notifyConsent: row.notify_consent,
    notifyConsentAt: row.notify_consent_at, createdAt: row.created_at
  };
}

async function findFollow(sql: Sql, organizationId: string, accountId: string, target: FollowTarget) {
  const [row] = await sql<Parameters<typeof toRecord>[0][]>`
    SELECT id, target_type, COALESCE(profile_id, competition_id, organization_id) AS target_id,
      notify_consent, notify_consent_at, created_at
    FROM follows
    WHERE organization_id = ${organizationId} AND follower_account_id = ${accountId}
      AND target_type = ${target.type} AND COALESCE(profile_id, competition_id, organization_id) = ${target.id}
  `;
  return row ? toRecord(row) : null;
}

/** Idempotent follow. Returns created=false when the follow already existed. */
export async function follow(
  organizationId: string,
  accountId: string,
  target: FollowTarget
): Promise<{ follow: FollowRecord; created: boolean }> {
  await requireEnabledFeature("follows", { organizationId, accountId });
  const sql = getSqlClient();
  if (!(await targetVisible(sql, organizationId, target, accountId))) throw new DomainError("follow_target_not_found");
  const columns = targetColumns(target);
  const inserted = await sql`
    INSERT INTO follows (organization_id, follower_account_id, target_type, profile_id, competition_id)
    VALUES (${organizationId}, ${accountId}, ${target.type}, ${columns.profile_id}, ${columns.competition_id})
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  const record = await findFollow(sql, organizationId, accountId, target);
  if (!record) throw new DomainError("follow_conflict");
  return { follow: record, created: inserted.length === 1 };
}

/** Idempotent unfollow. Withdraws any notification consent with an audit record. */
export async function unfollow(organizationId: string, accountId: string, target: FollowTarget): Promise<{ removed: boolean }> {
  await requireEnabledFeature("follows", { organizationId, accountId });
  return getSqlClient().begin(async tx => {
    const rows = await tx<{ id: string; notify_consent: boolean }[]>`
      DELETE FROM follows
      WHERE organization_id = ${organizationId} AND follower_account_id = ${accountId}
        AND target_type = ${target.type} AND COALESCE(profile_id, competition_id, organization_id) = ${target.id}
      RETURNING id, notify_consent
    `;
    if (rows[0]?.notify_consent) {
      await recordAudit(tx, {
        organizationId, actorAccountId: accountId, action: "follow.notification_consent_withdrawn",
        subjectType: "follow", subjectId: rows[0].id, details: { targetType: target.type, targetId: target.id, via: "unfollow" }
      });
    }
    return { removed: rows.length === 1 };
  });
}

/**
 * Explicit notification opt-in/out for an existing follow. Records the time of the
 * decision and an audit event; repeating the current value is a no-op.
 */
export async function setNotificationConsent(
  organizationId: string,
  accountId: string,
  target: FollowTarget,
  consent: boolean
): Promise<FollowRecord> {
  if (typeof consent !== "boolean") throw new DomainError("invalid_consent");
  await requireEnabledFeature("follows", { organizationId, accountId });
  return getSqlClient().begin(async tx => {
    const [row] = await tx<{ id: string; notify_consent: boolean }[]>`
      SELECT id, notify_consent FROM follows
      WHERE organization_id = ${organizationId} AND follower_account_id = ${accountId}
        AND target_type = ${target.type} AND COALESCE(profile_id, competition_id, organization_id) = ${target.id}
      FOR UPDATE
    `;
    if (!row) throw new DomainError("follow_not_found");
    if (row.notify_consent !== consent) {
      await tx`UPDATE follows SET notify_consent = ${consent}, notify_consent_at = now() WHERE id = ${row.id}`;
      await recordAudit(tx, {
        organizationId, actorAccountId: accountId,
        action: consent ? "follow.notification_consent_granted" : "follow.notification_consent_withdrawn",
        subjectType: "follow", subjectId: row.id, details: { targetType: target.type, targetId: target.id }
      });
    }
    return (await findFollow(tx, organizationId, accountId, target))!;
  });
}

/** The caller's own follows (never anyone else's). */
export async function listMyFollows(organizationId: string, accountId: string, options: { limit?: number; after?: string } = {}) {
  await requireEnabledFeature("follows", { organizationId, accountId });
  if (options.after !== undefined && !isUuid(options.after)) throw new DomainError("invalid_cursor");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const sql = getSqlClient();
  const rows = await sql<Parameters<typeof toRecord>[0][]>`
    SELECT id, target_type, COALESCE(profile_id, competition_id, organization_id) AS target_id,
      notify_consent, notify_consent_at, created_at
    FROM follows
    WHERE organization_id = ${organizationId} AND follower_account_id = ${accountId}
      ${options.after ? sql`AND id > ${options.after}` : sql``}
    ORDER BY id LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit).map(toRecord);
  return { follows: page, next: rows.length > limit ? page[page.length - 1]!.id : null };
}

/** Follower count for a target the viewer may see; null when not visible (treat as 404). */
export async function followerCount(organizationId: string, target: FollowTarget, viewerAccountId: string | null): Promise<number | null> {
  await requireEnabledFeature("follows", { organizationId });
  const sql = getSqlClient();
  if (!(await targetVisible(sql, organizationId, target, viewerAccountId))) return null;
  const [row] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM follows
    WHERE organization_id = ${organizationId} AND target_type = ${target.type}
      AND COALESCE(profile_id, competition_id, organization_id) = ${target.id}
  `;
  return Number(row?.count ?? 0);
}

/**
 * SERVER-ONLY: accounts that explicitly consented to notifications about a target
 * and are still active members. For notification dispatchers; never expose via HTTP.
 */
export async function listConsentedFollowers(organizationId: string, target: FollowTarget): Promise<string[]> {
  const rows = await getSqlClient()<{ follower_account_id: string }[]>`
    SELECT f.follower_account_id FROM follows f
    JOIN organization_memberships m ON m.organization_id = f.organization_id AND m.account_id = f.follower_account_id
    WHERE f.organization_id = ${organizationId} AND f.target_type = ${target.type}
      AND COALESCE(f.profile_id, f.competition_id, f.organization_id) = ${target.id}
      AND f.notify_consent AND m.status = 'active'
    ORDER BY f.follower_account_id
  `;
  return rows.map(row => row.follower_account_id);
}
