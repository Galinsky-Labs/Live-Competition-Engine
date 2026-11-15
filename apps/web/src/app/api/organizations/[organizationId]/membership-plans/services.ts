import { checkoutUrls, lazyPaymentProvider, paymentProvider } from "@live-competition-engine/db/payment-runtime";
import {
  archivePlan,
  cancelSubscription,
  createMembershipPlan,
  getSubscription,
  listAccountSubscriptions,
  listMembershipPlans,
  subscribe
} from "@live-competition-engine/db/subscriptions";
import { authService } from "../../../../../lib/services";
import { createSubscriptionHandlers } from "./handlers";

let handlers: ReturnType<typeof createSubscriptionHandlers> | undefined;

export function subscriptionHandlers() {
  handlers ??= createSubscriptionHandlers(authService(), {
    listPlans: listMembershipPlans,
    createPlan: createMembershipPlan,
    archivePlan,
    subscribe: (organizationId, input) => subscribe(organizationId, input, paymentProvider(), id => checkoutUrls(organizationId, id)),
    listMine: listAccountSubscriptions,
    get: (organizationId, subscriptionId) => getSubscription(organizationId, subscriptionId),
    cancel: (organizationId, subscriptionId, options) => cancelSubscription(organizationId, subscriptionId, options, lazyPaymentProvider())
  });
  return handlers;
}
