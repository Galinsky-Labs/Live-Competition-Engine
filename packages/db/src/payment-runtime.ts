import { parseServerEnv } from "@live-competition-engine/config";
import { requireStripe } from "@live-competition-engine/config/providers";
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
