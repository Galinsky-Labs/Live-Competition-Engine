import type { PaymentHooks } from "./payments.ts";

/**
 * Composition point for everything that reacts to payment state: revenue
 * splits, ticket/PPV/entry-fee fulfillment, subscriptions, tips. Webhooks and
 * refund endpoints pass these hooks so every path applies the same effects.
 */
export function fulfillmentHooks(): PaymentHooks {
  return {};
}
