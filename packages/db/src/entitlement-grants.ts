import type { EntitlementCapability } from "@live-competition-engine/auth/entitlements";
import { DomainError } from "@live-competition-engine/domain";
import { recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * Trusted grant mutations for monetization workflows (LC-33..36). Grants are
 * written only from verified payment/subscription state inside the same
 * transaction, and every grant records its provenance in
 * entitlement_grant_sources so refunds and cancellations can find it.
 */
export type GrantSourceKind = "payment_order" | "subscription" | "manual";

export interface IssueGrantInput {
  organizationId: string;
  accountId: string;
  eventId: string | null;
  capability: EntitlementCapability;
  source: "ticket" | "subscription" | "manual";
  startsAt: number;
  expiresAt: number | null;
  sourceKind: GrantSourceKind;
  sourceId: string;
  actorAccountId?: string | null;
}

export async function issueGrant(tx: Sql, input: IssueGrantInput): Promise<string> {
  if (input.capability === "staff.operate") throw new DomainError("invalid_capability");
  if (input.expiresAt !== null && input.expiresAt <= input.startsAt) throw new DomainError("invalid_grant_window");
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO entitlement_grants (organization_id, account_id, event_id, capability, source, status, starts_at, expires_at)
    VALUES (${input.organizationId}, ${input.accountId}, ${input.eventId}, ${input.capability}, ${input.source}, 'active',
      ${input.startsAt}, ${input.expiresAt})
    RETURNING id
  `;
  await tx`
    INSERT INTO entitlement_grant_sources (grant_id, organization_id, source_kind, source_id)
    VALUES (${row!.id}, ${input.organizationId}, ${input.sourceKind}, ${input.sourceId})
  `;
  await recordAudit(tx, {
    organizationId: input.organizationId, actorAccountId: input.actorAccountId ?? null, action: "entitlement.granted",
    subjectType: "entitlement_grant", subjectId: row!.id,
    details: { accountId: input.accountId, capability: input.capability, eventId: input.eventId, sourceKind: input.sourceKind, sourceId: input.sourceId, expiresAt: input.expiresAt }
  });
  return row!.id;
}

/** Move every active/pending grant from a source to refunded or revoked. Returns the count. */
export async function endGrantsForSource(
  tx: Sql,
  organizationId: string,
  sourceKind: GrantSourceKind,
  sourceId: string,
  status: "refunded" | "revoked",
  actorAccountId: string | null = null
): Promise<number> {
  const rows = await tx<{ id: string }[]>`
    UPDATE entitlement_grants g SET status = ${status}
    FROM entitlement_grant_sources s
    WHERE s.grant_id = g.id AND s.organization_id = ${organizationId} AND g.organization_id = ${organizationId}
      AND s.source_kind = ${sourceKind} AND s.source_id = ${sourceId} AND g.status IN ('active', 'pending')
    RETURNING g.id
  `;
  for (const row of rows) {
    await recordAudit(tx, {
      organizationId, actorAccountId, action: `entitlement.${status}`, subjectType: "entitlement_grant", subjectId: row.id,
      details: { sourceKind, sourceId }
    });
  }
  return rows.length;
}

/** Shorten active grants from a source so they end at `endsAt` (e.g. immediate cancellation). */
export async function truncateGrantsForSource(tx: Sql, organizationId: string, sourceKind: GrantSourceKind, sourceId: string, endsAt: number): Promise<number> {
  const rows = await tx`
    UPDATE entitlement_grants g SET status = 'revoked'
    FROM entitlement_grant_sources s
    WHERE s.grant_id = g.id AND s.organization_id = ${organizationId} AND s.source_kind = ${sourceKind} AND s.source_id = ${sourceId}
      AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > ${endsAt})
    RETURNING g.id
  `;
  return rows.length;
}

/** Active, in-window grant check (same semantics as LC-09 EntitlementService, without decision logging). */
export async function hasActiveGrant(
  organizationId: string,
  accountId: string,
  capability: EntitlementCapability,
  eventId: string | null,
  now = Date.now(),
  sql: Sql = getSqlClient(),
  sourceKind?: GrantSourceKind,
  sourceIds?: readonly string[]
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM entitlement_grants g
    ${sourceKind ? sql`JOIN entitlement_grant_sources s ON s.grant_id = g.id AND s.source_kind = ${sourceKind} AND s.source_id = ANY(${sourceIds ?? []})` : sql``}
    WHERE g.organization_id = ${organizationId} AND g.account_id = ${accountId} AND g.capability = ${capability}
      AND g.status = 'active' AND g.starts_at <= ${now} AND (g.expires_at IS NULL OR g.expires_at > ${now})
      AND ${eventId === null ? sql`g.event_id IS NULL` : sql`(g.event_id = ${eventId} OR g.event_id IS NULL)`}
    LIMIT 1
  `;
  return rows.length === 1;
}

export async function grantsForSource(organizationId: string, sourceKind: GrantSourceKind, sourceId: string) {
  return getSqlClient()<{ id: string; status: string; capability: string; starts_at: string; expires_at: string | null }[]>`
    SELECT g.id, g.status, g.capability, g.starts_at::text, g.expires_at::text
    FROM entitlement_grants g JOIN entitlement_grant_sources s ON s.grant_id = g.id
    WHERE s.organization_id = ${organizationId} AND s.source_kind = ${sourceKind} AND s.source_id = ${sourceId}
    ORDER BY g.starts_at
  `;
}
