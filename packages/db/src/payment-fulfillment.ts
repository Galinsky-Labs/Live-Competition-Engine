import type { PaymentHooks } from "./payments.ts";
import { splitHooks } from "./revenue-splits.ts";

/**
 * Run several hook sets in order. onSucceeded/onFailed/onRefunded run for every
 * set; refundLines and onOtherEvent use the first set that defines them.
 */
export function composeHooks(...sets: PaymentHooks[]): PaymentHooks {
  return {
    async onSucceeded(tx, order, paymentTransactionId) {
      for (const set of sets) await set.onSucceeded?.(tx, order, paymentTransactionId);
    },
    async onFailed(tx, order) {
      for (const set of sets) await set.onFailed?.(tx, order);
    },
    async refundLines(tx, order, amountMinor, previouslyRefundedMinor) {
      const owner = sets.find(set => set.refundLines);
      if (owner?.refundLines) return owner.refundLines(tx, order, amountMinor, previouslyRefundedMinor);
      return [{ accountCode: "sales_clearing", amountMinor }, { accountCode: "provider_clearing", amountMinor: -amountMinor }];
    },
    async onRefunded(tx, order, refund, fullyRefunded) {
      for (const set of sets) await set.onRefunded?.(tx, order, refund, fullyRefunded);
    },
    async onOtherEvent(tx, provider, event, hooks) {
      for (const set of sets) {
        if (set.onOtherEvent) return set.onOtherEvent(tx, provider, event, hooks);
      }
      return { outcome: "unhandled", organizationId: null };
    }
  };
}

/**
 * Composition point for everything that reacts to payment state: revenue
 * splits first (so ledger allocation precedes fulfillment), then the
 * ticket/PPV/entry-fee, subscription, content and tip modules. Webhooks and
 * refund endpoints pass these hooks so every path applies the same effects.
 */
export function fulfillmentHooks(): PaymentHooks {
  return composeHooks(splitHooks);
}
