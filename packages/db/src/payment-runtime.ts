import { timingSafeEqual } from "node:crypto";
import { parseServerEnv } from "@live-competition-engine/config";
import { parseProviderEnv, ProviderNotConfiguredError, requireStripe } from "@live-competition-engine/config/providers";
import { StripePaymentProvider } from "./providers/stripe.ts";
import type { PaymentProvider } from "./providers/payments.ts";

let stripe: StripePaymentProvider | undefined;

/**
 * The production payment provider. Throws provider_not_configured (fail closed)
 * when STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are missing.
 */
export function paymentProvider(): PaymentProvider {
  stripe ??= new StripePaymentProvider({ secretKey: requireStripe().secretKey });
  return stripe;
}

const unconfigured = (): never => { throw new ProviderNotConfiguredError("stripe"); };

/**
 * Like paymentProvider(), but defers the configuration failure to the first
 * provider call, so free (zero-amount) flows work without Stripe credentials
 * while every paid path still fails closed.
 */
export function lazyPaymentProvider(): PaymentProvider {
  try {
    return paymentProvider();
  } catch (error) {
    if (!(error instanceof ProviderNotConfiguredError)) throw error;
    return {
      name: "stripe",
      createCheckout: async () => unconfigured(),
      createSubscriptionCheckout: async () => unconfigured(),
      refund: async () => unconfigured(),
      cancelSubscription: async () => unconfigured(),
      listCharges: async () => unconfigured()
    };
  }
}

/** Constant-time check of the scheduled-job bearer secret (JOB_WORKER_SECRET); fails closed. */
export function verifyJobSecret(header: string | null): boolean {
  const secret = parseProviderEnv().JOB_WORKER_SECRET;
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function stripeWebhookSecret(): string {
  return requireStripe().webhookSecret;
}

/** Hosted-checkout return URLs under the tenant's checkout pages. */
export function checkoutUrls(organizationId: string, reference: string): { successUrl: string; cancelUrl: string } {
  const base = parseServerEnv().APP_URL.replace(/\/$/, "");
  const id = encodeURIComponent(reference);
  return {
    successUrl: `${base}/checkout/${organizationId}/return?reference=${id}`,
    cancelUrl: `${base}/checkout/${organizationId}/cancelled?reference=${id}`
  };
}
