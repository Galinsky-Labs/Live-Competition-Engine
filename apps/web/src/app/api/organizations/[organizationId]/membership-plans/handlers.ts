import { validatePlanInput, type PlanInput } from "@live-competition-engine/domain/subscriptions";
import type { MembershipPlan, SubscribeResult, Subscription } from "@live-competition-engine/db/subscriptions";
import { errorResponse, isUuid, json, readJsonObject, requireAction, requireMember } from "../../../../../lib/http";
import { guarded, idempotencyKeyOf, requireOwnerOrManager, type MonetizationAuthorizer } from "../../../../../lib/monetization-http";

export interface SubscriptionServices {
  listPlans(organizationId: string, accountId: string): Promise<MembershipPlan[]>;
  createPlan(organizationId: string, input: PlanInput, actorAccountId: string): Promise<MembershipPlan>;
  archivePlan(organizationId: string, planId: string, actorAccountId: string): Promise<MembershipPlan>;
  subscribe(organizationId: string, input: { planId: string; accountId: string; consent: unknown; idempotencyKey: string }): Promise<SubscribeResult>;
  listMine(organizationId: string, accountId: string): Promise<Subscription[]>;
  get(organizationId: string, subscriptionId: string): Promise<Subscription | null>;
  cancel(organizationId: string, subscriptionId: string, options: { atPeriodEnd: boolean; actorAccountId: string }): Promise<Subscription>;
}

const planView = (plan: MembershipPlan) => ({
  id: plan.id, creatorType: plan.creatorType, creatorId: plan.creatorId, name: plan.name, description: plan.description,
  priceMinor: plan.priceMinor, currency: plan.currency, interval: plan.interval, termsVersion: plan.termsVersion
});
const subscriptionView = (s: Subscription) => ({
  id: s.id, planId: s.planId, status: s.status, currentPeriodStart: s.currentPeriodStart, currentPeriodEnd: s.currentPeriodEnd,
  cancelAtPeriodEnd: s.cancelAtPeriodEnd, consentTermsVersion: s.consentTermsVersion, consentAt: s.consentAt
});

/** LC-34 handlers: membership plans, consented subscriptions, cancellation. */
export function createSubscriptionHandlers(authorizer: MonetizationAuthorizer, services: SubscriptionServices) {
  return {
    async listPlans(request: Request, organizationId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      return guarded(async () => json({ plans: (await services.listPlans(organizationId, principal.accountId)).map(planView) }));
    },

    /** Creators may offer their own account plan; tenant and participant plans need tenant.manage. */
    async createPlan(request: Request, organizationId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      return guarded(async () => {
        const input = validatePlanInput(body);
        if (!(input.creatorType === "account" && input.creatorId === principal.accountId)) {
          const manager = await requireAction(authorizer, request, "tenant.manage", { organizationId });
          if (manager instanceof Response) return manager;
        }
        return json({ plan: planView(await services.createPlan(organizationId, input, principal.accountId)) }, 201);
      });
    },

    async archivePlan(request: Request, organizationId: string, planId: string) {
      const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
      if (principal instanceof Response) return principal;
      if (!isUuid(planId)) return errorResponse(404, "plan_not_found");
      return guarded(async () => json({ plan: planView(await services.archivePlan(organizationId, planId, principal.accountId)) }));
    },

    async subscribe(request: Request, organizationId: string, planId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(planId)) return errorResponse(404, "plan_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const idempotencyKey = idempotencyKeyOf(request, body);
      if (!idempotencyKey) return errorResponse(400, "invalid_idempotency_key");
      return guarded(async () => {
        const result = await services.subscribe(organizationId, { planId, accountId: principal.accountId, consent: body.consent, idempotencyKey });
        return json({ subscription: subscriptionView(result.subscription), redirectUrl: result.redirectUrl }, 201);
      });
    },

    async listMine(request: Request, organizationId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      return json({ subscriptions: (await services.listMine(organizationId, principal.accountId)).map(subscriptionView) });
    },

    async cancel(request: Request, organizationId: string, subscriptionId: string) {
      const principal = await requireOwnerOrManager(authorizer, request, organizationId, async () =>
        isUuid(subscriptionId) ? (await services.get(organizationId, subscriptionId))?.accountId ?? null : null);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      if (body.atPeriodEnd !== undefined && typeof body.atPeriodEnd !== "boolean") return errorResponse(400, "invalid_body");
      return guarded(async () => json({
        subscription: subscriptionView(await services.cancel(organizationId, subscriptionId, { atPeriodEnd: body.atPeriodEnd !== false, actorAccountId: principal.accountId }))
      }));
    }
  };
}
