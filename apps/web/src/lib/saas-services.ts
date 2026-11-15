import * as plans from "@live-competition-engine/db/saas-plans";
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

/** Tenant lifecycle guard for tenant-scoped APIs in this module (replaced by LC-53 assertTenantActive). */
export const tenantGuard = async (_organizationId: string): Promise<void> => undefined;

export { authService };
