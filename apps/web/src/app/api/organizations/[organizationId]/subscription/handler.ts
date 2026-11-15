import type {
  PlanChangeResult,
  PlanLimitDecision,
  SubscriptionResult,
  TenantSubscription,
  UsageAggregate,
  getSubscription
} from "@live-competition-engine/db/saas-plans";
import { PLAN_LIMIT_KEYS, parseUsagePeriod, type PlanLimitKey, type SubscriptionStatus } from "@live-competition-engine/domain/saas-plans";
import { isUuid } from "@live-competition-engine/domain";
import { domainFailure, errorResponse, json, readJsonObject, requireAction, type Authorizer } from "../../../../../lib/http";

export interface SubscriptionDeps {
  get: typeof getSubscription;
  start(organizationId: string, actorAccountId: string, input: { planId: string; idempotencyKey: string }): Promise<SubscriptionResult>;
  change(organizationId: string, actorAccountId: string, input: { planId: string; idempotencyKey: string; acknowledgeOverage?: boolean }): Promise<PlanChangeResult>;
  cancelPendingDowngrade(organizationId: string, actorAccountId: string): Promise<TenantSubscription>;
  setStatus(organizationId: string, actorAccountId: string | null, to: SubscriptionStatus, options?: { expectedRevision?: number; reason?: string }): Promise<TenantSubscription>;
  aggregateUsage(organizationId: string, periodStart: Date): Promise<UsageAggregate>;
  checkPlanLimit(organizationId: string, limitKey: PlanLimitKey, increment?: number): Promise<PlanLimitDecision>;
}

/** Optional tenant lifecycle guard (LC-53 assertTenantActive). Throws DomainError when the tenant is not active. */
export type TenantGuard = (organizationId: string) => Promise<void>;

const statusCodes = {
  plan_change_usage_exceeds_limits: 409,
  subscription_conflict: 409,
  plan_change_noop: 409,
  tenant_suspended: 423,
  tenant_scheduled_for_deletion: 423,
  tenant_deleted: 410
};

function planInput(body: Record<string, unknown>) {
  if (!isUuid(body.planId)) return null;
  if (typeof body.idempotencyKey !== "string") return null;
  if (body.acknowledgeOverage !== undefined && typeof body.acknowledgeOverage !== "boolean") return null;
  return { planId: body.planId, idempotencyKey: body.idempotencyKey, acknowledgeOverage: body.acknowledgeOverage === true };
}

/** LC-49 tenant subscription API: tenant.manage in the organization. */
export function createSubscriptionHandlers(
  authorizer: Pick<Authorizer, "authorizeAction">,
  deps: SubscriptionDeps,
  guard: TenantGuard = async () => undefined
) {
  const authorize = async (request: Request, organizationId: string) => {
    const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
    if (principal instanceof Response) return principal;
    try {
      await guard(organizationId);
    } catch (error) {
      return domainFailure(error, statusCodes);
    }
    return principal;
  };

  return {
    async get(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      const view = await deps.get(organizationId);
      if (!view) return errorResponse(404, "subscription_not_found");
      return json(view);
    },

    async start(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      const input = planInput(body);
      if (!input) return errorResponse(400, "invalid_subscription_request");
      try {
        const result = await deps.start(organizationId, principal.accountId, { planId: input.planId, idempotencyKey: input.idempotencyKey });
        return json(result, result.replayed ? 200 : 201);
      } catch (error) {
        return domainFailure(error, statusCodes);
      }
    },

    async change(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      const input = planInput(body);
      if (!input) return errorResponse(400, "invalid_subscription_request");
      try {
        const result = await deps.change(organizationId, principal.accountId, input);
        if (result.outcome === "blocked") {
          return errorResponse(409, "plan_change_usage_exceeds_limits", { violations: result.violations });
        }
        return json(result, result.outcome === "scheduled" ? 202 : 200);
      } catch (error) {
        return domainFailure(error, statusCodes);
      }
    },

    async cancelPendingChange(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      try {
        return json({ subscription: await deps.cancelPendingDowngrade(organizationId, principal.accountId) });
      } catch (error) {
        return domainFailure(error, statusCodes);
      }
    },

    async cancel(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
        return errorResponse(400, "invalid_reason");
      }
      try {
        const subscription = await deps.setStatus(organizationId, principal.accountId, "cancelled",
          typeof body.reason === "string" ? { reason: body.reason } : {});
        return json({ subscription });
      } catch (error) {
        return domainFailure(error, statusCodes);
      }
    },

    async usage(request: Request, organizationId: string): Promise<Response> {
      const principal = await authorize(request, organizationId);
      if (principal instanceof Response) return principal;
      const periodParam = new URL(request.url).searchParams.get("period");
      let period: Date;
      try {
        period = periodParam ? parseUsagePeriod(periodParam) : new Date();
      } catch (error) {
        return domainFailure(error);
      }
      const usage = await deps.aggregateUsage(organizationId, period);
      const limits = await Promise.all(PLAN_LIMIT_KEYS.map(key => deps.checkPlanLimit(organizationId, key, 0)));
      return json({ usage, limits });
    }
  };
}

const platformStatuses = new Set(["active", "past_due", "cancelled"]);

/** Platform/billing status override (platform.manage): active / past_due / cancelled. */
export function createPlatformSubscriptionStatusHandler(authorizer: Pick<Authorizer, "authorizeAction">, deps: Pick<SubscriptionDeps, "setStatus">) {
  return async function post(request: Request, organizationId: string): Promise<Response> {
    const principal = await requireAction(authorizer, request, "platform.manage");
    if (principal instanceof Response) return principal;
    if (!isUuid(organizationId)) return errorResponse(404, "not_found");
    const body = await readJsonObject(request, 4096);
    if (body instanceof Response) return body;
    if (typeof body.status !== "string" || !platformStatuses.has(body.status) ||
        (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1)) ||
        (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500))) {
      return errorResponse(400, "invalid_status_request");
    }
    try {
      const subscription = await deps.setStatus(organizationId, principal.accountId, body.status as SubscriptionStatus, {
        ...(body.expectedRevision !== undefined ? { expectedRevision: body.expectedRevision as number } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {})
      });
      return json({ subscription });
    } catch (error) {
      return domainFailure(error);
    }
  };
}
