import type { OnboardingView } from "@live-competition-engine/db/tenant-signup";
import { domainFailure, errorResponse, json, readJsonObject, requireAction, type Authorizer } from "../../../../../lib/http";

export interface OnboardingDeps {
  checklist(organizationId: string, actorAccountId: string): Promise<OnboardingView>;
  setSkipped(organizationId: string, actorAccountId: string, step: string, skipped: boolean): Promise<OnboardingView>;
  createFirstEvent(organizationId: string, actorAccountId: string, input: unknown): Promise<{ competitionId: string; created: boolean }>;
  /** LC-53 tenant lifecycle guard. */
  guard(organizationId: string): Promise<void>;
}

const statusCodes = {
  plan_limit_exceeded: 402,
  no_active_subscription: 402,
  tenant_suspended: 423,
  tenant_scheduled_for_deletion: 423,
  tenant_deleted: 410
};

/** LC-50 onboarding checklist and guided first event: tenant.manage in the organization. */
export function createOnboardingHandlers(authorizer: Pick<Authorizer, "authorizeAction">, deps: OnboardingDeps) {
  const authorize = async (request: Request, organizationId: string) => {
    const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
    if (principal instanceof Response) return principal;
    try {
      await deps.guard(organizationId);
    } catch (error) {
      return domainFailure(error, statusCodes);
    }
    return principal;
  };

  return {
    async get(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      try {
        return json(await deps.checklist(organizationId, principal.accountId));
      } catch (error) {
        return domainFailure(error);
      }
    },

    async skip(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      if (typeof body.step !== "string" || typeof body.skipped !== "boolean") return errorResponse(400, "invalid_onboarding_step");
      try {
        return json(await deps.setSkipped(organizationId, principal.accountId, body.step, body.skipped));
      } catch (error) {
        return domainFailure(error);
      }
    },

    async firstEvent(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      try {
        const result = await deps.createFirstEvent(organizationId, principal.accountId, body);
        return json(result, result.created ? 201 : 200);
      } catch (error) {
        return domainFailure(error, statusCodes);
      }
    }
  };
}
