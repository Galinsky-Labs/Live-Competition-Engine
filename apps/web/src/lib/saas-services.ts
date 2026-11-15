import * as plans from "@live-competition-engine/db/saas-plans";
import { assertTenantActive } from "@live-competition-engine/db/platform-admin";
import { authService } from "./services";

/** Postgres-backed wiring for LC-49 plan/subscription/usage handlers. */
export const planAdminDeps = {
  list: plans.listPlans,
  create: plans.createPlanVersion,
  publish: plans.publishPlan,
  retire: plans.retirePlan
};

export const subscriptionDeps = {
  get: plans.getSubscription,
  start: plans.startSubscription,
  change: plans.changePlan,
  cancelPendingDowngrade: plans.cancelPendingDowngrade,
  setStatus: plans.setSubscriptionStatus,
  aggregateUsage: plans.aggregateUsage,
  checkPlanLimit: plans.checkPlanLimit
};

/** LC-53 tenant lifecycle guard for tenant-scoped APIs: suspended/deleted tenants are refused. */
export const tenantGuard = (organizationId: string): Promise<void> => assertTenantActive(organizationId);

export { authService };
