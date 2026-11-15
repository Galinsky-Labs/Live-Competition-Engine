/**
 * Payment provider contract. The engine never trusts client-reported payment
 * state: orders change only through provider-verified events (webhooks) that are
 * normalized into `PaymentEvent` values, or through deterministic fakes in tests.
 */
export type PaymentProviderName = "stripe" | "fake";

export interface CheckoutInput {
  organizationId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  /** Provider-side session expiry aligned with capacity holds (Stripe allows 30 min to 24 h). */
  expiresAt?: Date;
}

export interface SubscriptionCheckoutInput {
  organizationId: string;
  subscriptionId: string;
  amountMinor: number;
  currency: string;
  interval: "month" | "year";
  description: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface CheckoutSession {
  reference: string;
  redirectUrl: string;
}

export interface RefundInput {
  organizationId: string;
  refundId: string;
  paymentReference: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface ProviderRefund {
  reference: string;
  status: "pending" | "succeeded" | "failed";
}

/** A captured charge as the provider reports it, for reconciliation. */
export interface ProviderCharge {
  chargeId: string;
  paymentReference: string | null;
  amountCapturedMinor: number;
  amountRefundedMinor: number;
  currency: string;
  createdAt: Date;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<CheckoutSession>;
  refund(input: RefundInput): Promise<ProviderRefund>;
  cancelSubscription(input: { providerSubscriptionId: string; atPeriodEnd: boolean; idempotencyKey: string }): Promise<void>;
  listCharges(input: { since: Date; until: Date }): Promise<ProviderCharge[]>;
}

/** Provider-agnostic events produced by verified webhooks (or the fake provider). */
export type PaymentEvent =
  | { kind: "payment_succeeded"; organizationId: string; orderId: string; paymentReference: string; amountMinor: number; currency: string }
  | { kind: "payment_failed"; organizationId: string; orderId: string; failureCode: string }
  | { kind: "payment_cancelled"; organizationId: string; orderId: string }
  | { kind: "refund_updated"; organizationId: string; refundId: string; providerRefundReference: string; status: "pending" | "succeeded" | "failed" }
  | { kind: "chargeback"; paymentReference: string; amountMinor: number; currency: string; disputeId: string }
  | { kind: "subscription_checkout_completed"; organizationId: string; subscriptionId: string; providerSubscriptionId: string }
  | { kind: "subscription_checkout_expired"; organizationId: string; subscriptionId: string }
  | { kind: "invoice_paid"; providerSubscriptionId: string; invoiceId: string; paymentReference: string | null; amountMinor: number; currency: string; periodStart: Date; periodEnd: Date }
  | { kind: "invoice_payment_failed"; providerSubscriptionId: string; invoiceId: string }
  | { kind: "subscription_ended"; providerSubscriptionId: string };
