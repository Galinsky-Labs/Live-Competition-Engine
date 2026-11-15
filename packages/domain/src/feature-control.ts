import { DomainError } from "./index.ts";

export type ControllingLayer = "platform" | "ceiling" | "tenant";

export interface EffectiveFeature {
  feature: string;
  enabled: boolean;
  /** Which layer decides the tenant-wide outcome. */
  controlledBy: ControllingLayer;
  platform: { enabled: boolean | null; revision: number };
  tenant: { enabled: boolean | null; revision: number };
  ceiling: { locked: boolean; revision: number; reason: string | null };
  /** Whether a tenant operator could turn this on today. */
  tenantMayEnable: boolean;
}

export interface FlagRow { feature: string; enabled: boolean; revision: number }
export interface CeilingRow { feature: string; locked: boolean; revision: number; reason: string | null }

/**
 * Tenant-wide effective view (event/account overrides can only veto further).
 * Mirrors LC-08 semantics: the platform must explicitly enable; any explicit
 * false vetoes; a platform ceiling lock is a veto owned by the platform.
 */
export function effectiveFeatureView(
  features: readonly string[],
  platform: readonly FlagRow[],
  tenant: readonly FlagRow[],
  ceilings: readonly CeilingRow[]
): EffectiveFeature[] {
  const p = new Map(platform.map(row => [row.feature, row]));
  const t = new Map(tenant.map(row => [row.feature, row]));
  const c = new Map(ceilings.map(row => [row.feature, row]));
  return features.map(feature => {
    const platformRow = p.get(feature);
    const tenantRow = t.get(feature);
    const ceilingRow = c.get(feature);
    const platformOn = platformRow?.enabled === true;
    const locked = ceilingRow?.locked === true;
    const tenantVeto = tenantRow?.enabled === false;
    const controlledBy: ControllingLayer = !platformOn ? "platform" : locked ? "ceiling" : tenantVeto ? "tenant" : "platform";
    return {
      feature,
      enabled: platformOn && !locked && !tenantVeto,
      controlledBy,
      platform: { enabled: platformRow?.enabled ?? null, revision: platformRow?.revision ?? 0 },
      tenant: { enabled: tenantRow?.enabled ?? null, revision: tenantRow?.revision ?? 0 },
      ceiling: { locked, revision: ceilingRow?.revision ?? 0, reason: ceilingRow?.reason ?? null },
      tenantMayEnable: !locked
    };
  });
}

/** Tenant-side writes may always disable; enabling is refused under a platform lock. */
export function assertTenantWriteAllowed(enabled: boolean, locked: boolean): void {
  if (enabled && locked) throw new DomainError("feature_locked_by_platform");
}
