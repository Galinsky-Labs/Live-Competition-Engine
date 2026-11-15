import { featureKeySchema, type FeatureKey } from "@live-competition-engine/config/features";
import { DomainError, isBoundedText, isUuid } from "@live-competition-engine/domain";
import { assertTenantWriteAllowed, effectiveFeatureView, type EffectiveFeature } from "@live-competition-engine/domain/feature-control";
import { recordAudit, type Sql } from "./audit.ts";
import { setFeatureFlag, type FeatureFlagUpdate } from "./feature-flags.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-44 wrapper around LC-08 `setFeatureFlag`. It adds platform-owned per-tenant
 * ceilings and an audit record for every change. Callers authorize first:
 * platform.manage for platform flags and ceilings, tenant.manage for tenant-side scopes.
 *
 * Race safety: a transaction-scoped advisory lock per (tenant, feature) is held while the
 * ceiling is read and the LC-08 write runs (shared for tenant writes, exclusive for
 * ceiling changes), so a tenant enable cannot interleave with a platform lock.
 */

const lockKey = (organizationId: string, feature: string) => `feature-ceiling:${organizationId}:${feature}`;

function parseFeature(value: unknown): FeatureKey {
  const parsed = featureKeySchema.safeParse(value);
  if (!parsed.success) throw new DomainError("invalid_feature");
  return parsed.data;
}

function parseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DomainError("invalid_expected_revision");
  return value;
}

/** Translate LC-08's plain errors into DomainError codes. */
async function lc08Write(update: FeatureFlagUpdate, tx: Sql): Promise<number> {
  try {
    return await setFeatureFlag(update, tx);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/revision conflict/.test(message)) throw new DomainError("revision_conflict");
    if (/Invalid |Unexpected |scope denied/.test(message) || (error as { name?: string })?.name === "ZodError") {
      throw new DomainError("invalid_feature_scope");
    }
    throw error;
  }
}

export async function setPlatformFeature(
  actorAccountId: string,
  input: { feature: unknown; enabled: unknown; expectedRevision: unknown }
): Promise<{ revision: number }> {
  const feature = parseFeature(input.feature);
  if (typeof input.enabled !== "boolean") throw new DomainError("invalid_enabled");
  const expectedRevision = parseRevision(input.expectedRevision);
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"feature-platform:" + feature}, 0))`;
    const revision = await lc08Write({ scope: "platform", feature, enabled: input.enabled as boolean, expectedRevision, actorAccountId }, tx);
    await recordAudit(tx, {
      organizationId: null, actorAccountId, action: "feature.platform_flag_set", subjectType: "feature_flag",
      subjectId: `platform:${feature}`, details: { feature, enabled: input.enabled, revision }
    });
    return { revision };
  });
}

export interface ScopedFeatureInput {
  scope: unknown;
  feature: unknown;
  enabled: unknown;
  expectedRevision: unknown;
  eventId?: unknown;
  accountId?: unknown;
}

async function ceilingLocked(tx: Sql, organizationId: string, feature: string): Promise<boolean> {
  const [row] = await tx<{ locked: boolean }[]>`
    SELECT locked FROM tenant_feature_ceilings WHERE organization_id = ${organizationId} AND feature = ${feature}
  `;
  return row?.locked === true;
}

/** Tenant-side write (tenant, event or account scope) that respects the platform ceiling. */
export async function setTenantScopedFeature(
  organizationId: string,
  actorAccountId: string,
  input: ScopedFeatureInput
): Promise<{ revision: number }> {
  if (!isUuid(organizationId)) throw new DomainError("organization_not_found");
  const scope = input.scope;
  if (scope !== "tenant" && scope !== "event" && scope !== "account") throw new DomainError("invalid_feature_scope");
  const feature = parseFeature(input.feature);
  if (typeof input.enabled !== "boolean") throw new DomainError("invalid_enabled");
  const enabled = input.enabled;
  const expectedRevision = parseRevision(input.expectedRevision);
  if (scope === "event" && !isUuid(input.eventId)) throw new DomainError("invalid_feature_scope");
  if (scope === "account" && !isUuid(input.accountId)) throw new DomainError("invalid_feature_scope");
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${lockKey(organizationId, feature)}, 0))`;
    assertTenantWriteAllowed(enabled, await ceilingLocked(tx, organizationId, feature));
    const revision = await lc08Write({
      scope, organizationId, feature, enabled, expectedRevision, actorAccountId,
      ...(scope === "event" ? { eventId: input.eventId as string } : {}),
      ...(scope === "account" ? { accountId: input.accountId as string } : {})
    }, tx);
    const target = scope === "event" ? input.eventId : scope === "account" ? input.accountId : organizationId;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "feature.tenant_flag_set", subjectType: "feature_flag",
      subjectId: `${scope}:${target}:${feature}`, details: { scope, feature, enabled, revision }
    });
    return { revision };
  });
}

/**
 * Platform sets or clears a ceiling. Locking also forces the tenant-scope flag to false
 * through LC-08, so every existing `requireEnabledFeature` call observes the lock as a
 * tenant veto without needing to know about ceilings.
 */
export async function setTenantCeiling(
  actorAccountId: string,
  input: { organizationId: unknown; feature: unknown; locked: unknown; reason?: unknown; expectedRevision: unknown }
): Promise<{ revision: number; tenantFlagRevision: number | null }> {
  if (!isUuid(input.organizationId)) throw new DomainError("organization_not_found");
  const organizationId = input.organizationId;
  const feature = parseFeature(input.feature);
  if (typeof input.locked !== "boolean") throw new DomainError("invalid_locked");
  const locked = input.locked;
  const reason = input.reason ?? null;
  if (reason !== null && !isBoundedText(reason, 500)) throw new DomainError("invalid_reason");
  const expectedRevision = parseRevision(input.expectedRevision);
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(organizationId, feature)}, 0))`;
    const org = await tx`SELECT 1 FROM organizations WHERE id = ${organizationId}`;
    if (org.length !== 1) throw new DomainError("organization_not_found");
    const rows = await tx<{ revision: number }[]>`
      INSERT INTO tenant_feature_ceilings (organization_id, feature, locked, reason, revision, updated_by_account_id)
      VALUES (${organizationId}, ${feature}, ${locked}, ${reason as string | null}, 1, ${actorAccountId})
      ON CONFLICT (organization_id, feature) DO UPDATE SET locked = EXCLUDED.locked, reason = EXCLUDED.reason,
        revision = tenant_feature_ceilings.revision + 1, updated_by_account_id = EXCLUDED.updated_by_account_id, updated_at = now()
      WHERE tenant_feature_ceilings.revision = ${expectedRevision}
      RETURNING revision
    `;
    if (rows.length !== 1 || (rows[0]!.revision === 1 && expectedRevision !== 0)) throw new DomainError("revision_conflict");
    const revision = rows[0]!.revision;
    let tenantFlagRevision: number | null = null;
    if (locked) {
      const [flag] = await tx<{ enabled: boolean; revision: number }[]>`
        SELECT enabled, revision FROM feature_flags WHERE scope_key = ${`tenant:${organizationId}`} AND feature = ${feature}
      `;
      if (!flag || flag.enabled) {
        tenantFlagRevision = await lc08Write({
          scope: "tenant", organizationId, feature, enabled: false, expectedRevision: flag?.revision ?? 0, actorAccountId
        }, tx);
      } else {
        tenantFlagRevision = flag.revision;
      }
    }
    const details = { organizationId, feature, locked, reason, revision, tenantFlagRevision };
    await recordAudit(tx, {
      organizationId: null, actorAccountId, action: "feature.ceiling_set", subjectType: "feature_ceiling",
      subjectId: `${organizationId}:${feature}`, details
    });
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "feature.ceiling_set", subjectType: "feature_ceiling",
      subjectId: `${organizationId}:${feature}`, details
    });
    return { revision, tenantFlagRevision };
  });
}

export async function effectiveTenantFeatures(organizationId: string): Promise<EffectiveFeature[]> {
  const sql = getSqlClient();
  const [platform, tenant, ceilings] = await Promise.all([
    sql<{ feature: string; enabled: boolean; revision: number }[]>`SELECT feature, enabled, revision FROM feature_flags WHERE scope_key = 'platform'`,
    sql<{ feature: string; enabled: boolean; revision: number }[]>`SELECT feature, enabled, revision FROM feature_flags WHERE scope_key = ${`tenant:${organizationId}`}`,
    sql<{ feature: string; locked: boolean; revision: number; reason: string | null }[]>`
      SELECT feature, locked, revision, reason FROM tenant_feature_ceilings WHERE organization_id = ${organizationId}`
  ]);
  return effectiveFeatureView(featureKeySchema.options, platform, tenant, ceilings);
}

export async function listPlatformFeatures() {
  const rows = await getSqlClient()<{ feature: string; enabled: boolean; revision: number; updated_at: Date }[]>`
    SELECT feature, enabled, revision, updated_at FROM feature_flags WHERE scope_key = 'platform'
  `;
  const byFeature = new Map(rows.map(row => [row.feature, row]));
  return featureKeySchema.options.map(feature => ({
    feature,
    enabled: byFeature.get(feature)?.enabled ?? null,
    revision: byFeature.get(feature)?.revision ?? 0,
    updatedAt: byFeature.get(feature)?.updated_at ?? null
  }));
}

/** Platform view of tenant-scope overrides and ceilings across tenants. */
export async function listTenantOverrides(options: { feature?: unknown; organizationId?: unknown; limit?: number } = {}) {
  const feature = options.feature === undefined || options.feature === null ? null : parseFeature(options.feature);
  const organizationId = options.organizationId === undefined || options.organizationId === null ? null : options.organizationId;
  if (organizationId !== null && !isUuid(organizationId)) throw new DomainError("invalid_organization_id");
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  const sql = getSqlClient();
  const rows = await sql<{
    organization_id: string; organization_name: string; feature: string; tenant_enabled: boolean | null; tenant_revision: number | null;
    locked: boolean | null; ceiling_revision: number | null; reason: string | null;
  }[]>`
    SELECT o.id AS organization_id, o.name AS organization_name, k.feature,
      f.enabled AS tenant_enabled, f.revision AS tenant_revision, c.locked, c.revision AS ceiling_revision, c.reason
    FROM (
      SELECT organization_id, feature FROM feature_flags WHERE scope = 'tenant'
      UNION SELECT organization_id, feature FROM tenant_feature_ceilings
    ) k
    JOIN organizations o ON o.id = k.organization_id
    LEFT JOIN feature_flags f ON f.scope_key = 'tenant:' || k.organization_id::text AND f.feature = k.feature
    LEFT JOIN tenant_feature_ceilings c ON c.organization_id = k.organization_id AND c.feature = k.feature
    WHERE TRUE
      ${feature ? sql`AND k.feature = ${feature}` : sql``}
      ${organizationId ? sql`AND k.organization_id = ${organizationId as string}` : sql``}
    ORDER BY o.name, k.feature
    LIMIT ${limit}
  `;
  return rows.map(row => ({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    feature: row.feature,
    tenant: { enabled: row.tenant_enabled, revision: row.tenant_revision ?? 0 },
    ceiling: { locked: row.locked === true, revision: row.ceiling_revision ?? 0, reason: row.reason }
  }));
}
