import { listAuditEvents } from "@live-competition-engine/db/audit";
import * as control from "@live-competition-engine/db/feature-control";
import { createFeatureControlHandlers, type FeatureControlService } from "../app/api/platform/features/handlers";
import { authService } from "./services";

async function listFeatureAudit(organizationId: string | null) {
  const [flags, ceilings] = await Promise.all([
    listAuditEvents(organizationId, { subjectType: "feature_flag", limit: 100 }),
    listAuditEvents(organizationId, { subjectType: "feature_ceiling", limit: 100 })
  ]);
  return [...flags, ...ceilings].sort((a, b) => Number(b.sequence) - Number(a.sequence)).slice(0, 100);
}

export const featureControlService: FeatureControlService = {
  setPlatformFeature: control.setPlatformFeature,
  setTenantScopedFeature: control.setTenantScopedFeature,
  setTenantCeiling: control.setTenantCeiling,
  effectiveTenantFeatures: control.effectiveTenantFeatures,
  listPlatformFeatures: control.listPlatformFeatures,
  listTenantOverrides: control.listTenantOverrides,
  listFeatureAudit
};

let handlers: ReturnType<typeof createFeatureControlHandlers> | undefined;

export function featureControlHandlers() {
  handlers ??= createFeatureControlHandlers(authService(), featureControlService);
  return handlers;
}
