import type { AuthorizedPrincipal, ProtectedAction } from "@live-competition-engine/auth";
import type { EffectiveFeature } from "@live-competition-engine/domain/feature-control";
import type { ScopedFeatureInput } from "@live-competition-engine/db/feature-control";
import { domainFailure, json, readJsonObject, requireAction, type Authorizer } from "../../../../lib/http";

export interface FeatureControlService {
  setPlatformFeature(actor: string, input: { feature: unknown; enabled: unknown; expectedRevision: unknown }): Promise<{ revision: number }>;
  setTenantScopedFeature(organizationId: string, actor: string, input: ScopedFeatureInput): Promise<{ revision: number }>;
  setTenantCeiling(actor: string, input: { organizationId: unknown; feature: unknown; locked: unknown; reason?: unknown; expectedRevision: unknown }): Promise<{ revision: number; tenantFlagRevision: number | null }>;
  effectiveTenantFeatures(organizationId: string): Promise<EffectiveFeature[]>;
  listPlatformFeatures(): Promise<unknown[]>;
  listTenantOverrides(options: { feature?: unknown; organizationId?: unknown; limit?: number }): Promise<unknown[]>;
  listFeatureAudit(organizationId: string | null): Promise<unknown[]>;
}

const statusByCode = { feature_locked_by_platform: 403, revision_conflict: 409 };

async function guarded(
  authorizer: Authorizer, request: Request, action: ProtectedAction, organizationId: string | undefined,
  run: (principal: AuthorizedPrincipal) => Promise<Response>
): Promise<Response> {
  const principal = await requireAction(authorizer, request, action, organizationId ? { organizationId } : {});
  if (principal instanceof Response) return principal;
  try {
    return await run(principal);
  } catch (error) {
    return domainFailure(error, statusByCode);
  }
}

export function createFeatureControlHandlers(authorizer: Authorizer, service: FeatureControlService) {
  return {
    /** GET /api/platform/features */
    platformList: (request: Request) => guarded(authorizer, request, "platform.manage", undefined, async () =>
      json({ features: await service.listPlatformFeatures() })),

    /** POST /api/platform/features {feature, enabled, expectedRevision} */
    platformSet: (request: Request) => guarded(authorizer, request, "platform.manage", undefined, async principal => {
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      return json(await service.setPlatformFeature(principal.accountId, {
        feature: body.feature, enabled: body.enabled, expectedRevision: body.expectedRevision
      }));
    }),

    /** GET /api/platform/features/overrides?feature&organizationId */
    platformOverrides: (request: Request) => guarded(authorizer, request, "platform.manage", undefined, async () => {
      const url = new URL(request.url);
      return json({ overrides: await service.listTenantOverrides({
        feature: url.searchParams.get("feature") ?? undefined,
        organizationId: url.searchParams.get("organizationId") ?? undefined
      }) });
    }),

    /** PUT /api/platform/features/ceilings {organizationId, feature, locked, reason?, expectedRevision} */
    platformCeiling: (request: Request) => guarded(authorizer, request, "platform.manage", undefined, async principal => {
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      return json(await service.setTenantCeiling(principal.accountId, {
        organizationId: body.organizationId, feature: body.feature, locked: body.locked,
        reason: body.reason, expectedRevision: body.expectedRevision
      }));
    }),

    /** GET /api/platform/features/audit */
    platformAudit: (request: Request) => guarded(authorizer, request, "platform.manage", undefined, async () =>
      json({ events: await service.listFeatureAudit(null) })),

    /** GET /api/organizations/{org}/features — effective flags with controlling layer. */
    tenantEffective: (request: Request, organizationId: string) => guarded(authorizer, request, "tenant.manage", organizationId, async () =>
      json({ features: await service.effectiveTenantFeatures(organizationId) })),

    /** PUT /api/organizations/{org}/features {scope, feature, enabled, expectedRevision, eventId?, accountId?} */
    tenantSet: (request: Request, organizationId: string) => guarded(authorizer, request, "tenant.manage", organizationId, async principal => {
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      return json(await service.setTenantScopedFeature(organizationId, principal.accountId, {
        scope: body.scope, feature: body.feature, enabled: body.enabled, expectedRevision: body.expectedRevision,
        eventId: body.eventId, accountId: body.accountId
      }));
    })
  };
}
