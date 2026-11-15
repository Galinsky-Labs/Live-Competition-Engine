import {
  cancelPaymentOrder,
  getPaymentOrder,
  ledgerBalances,
  ledgerTrialBalance,
  listOrderRefunds,
  reconcilePayments,
  requestRefund
} from "@live-competition-engine/db/payments";
import { fulfillmentHooks } from "@live-competition-engine/db/payment-fulfillment";
import { paymentProvider } from "@live-competition-engine/db/payment-runtime";
import { authService } from "../../../../../lib/services";
import { createPaymentHandlers } from "./handlers";

let handlers: ReturnType<typeof createPaymentHandlers> | undefined;

/** Postgres + Stripe wiring, constructed lazily so builds never need credentials. */
export function paymentHandlers() {
  handlers ??= createPaymentHandlers(authService(), {
    getOrder: (organizationId, orderId) => getPaymentOrder(organizationId, orderId),
    cancelOrder: (organizationId, orderId) => cancelPaymentOrder(organizationId, orderId, fulfillmentHooks()),
    listRefunds: listOrderRefunds,
    refund: input => requestRefund(input, paymentProvider(), fulfillmentHooks()),
    balances: organizationId => ledgerBalances(organizationId),
    trialBalance: organizationId => ledgerTrialBalance(organizationId),
    reconcile: (organizationId, window) => reconcilePayments(organizationId, paymentProvider(), window)
  });
  return handlers;
}
