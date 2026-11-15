import { createHash } from "node:crypto";
import { DomainError } from "@live-competition-engine/domain";
import type {
  CheckoutInput,
  CheckoutSession,
  PaymentProvider,
  ProviderCharge,
  ProviderRefund,
  RefundInput,
  SubscriptionCheckoutInput
} from "./payments.ts";

const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/**
 * Deterministic in-memory payment provider for tests and local development.
 * It proves engine bookkeeping only; it says nothing about real provider behavior.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = "fake" as const;
  readonly checkouts = new Map<string, CheckoutInput | SubscriptionCheckoutInput>();
  readonly refunds = new Map<string, RefundInput>();
  readonly cancellations: { providerSubscriptionId: string; atPeriodEnd: boolean }[] = [];
  readonly charges: ProviderCharge[] = [];
  /** Next refund outcome; tests flip this to exercise failures. */
  refundOutcome: ProviderRefund["status"] = "succeeded";
  failNextCall = false;
  calls = 0;

  private guard() {
    this.calls += 1;
    if (this.failNextCall) {
      this.failNextCall = false;
      throw new DomainError("provider_unavailable");
    }
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    this.guard();
    const reference = `fake_cs_${short(input.idempotencyKey)}`;
    this.checkouts.set(reference, input);
    return { reference, redirectUrl: `https://payments.fake.invalid/checkout/${reference}` };
  }

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<CheckoutSession> {
    this.guard();
    const reference = `fake_cs_${short(input.idempotencyKey)}`;
    this.checkouts.set(reference, input);
    return { reference, redirectUrl: `https://payments.fake.invalid/checkout/${reference}` };
  }

  async refund(input: RefundInput): Promise<ProviderRefund> {
    this.guard();
    const reference = `fake_re_${short(input.idempotencyKey)}`;
    this.refunds.set(reference, input);
    if (this.refundOutcome === "succeeded") {
      const charge = this.charges.find(c => c.paymentReference === input.paymentReference);
      if (charge) charge.amountRefundedMinor += input.amountMinor;
    }
    return { reference, status: this.refundOutcome };
  }

  async cancelSubscription(input: { providerSubscriptionId: string; atPeriodEnd: boolean }): Promise<void> {
    this.guard();
    this.cancellations.push({ providerSubscriptionId: input.providerSubscriptionId, atPeriodEnd: input.atPeriodEnd });
  }

  async listCharges(input: { since: Date; until: Date }): Promise<ProviderCharge[]> {
    this.guard();
    return this.charges.filter(c => c.createdAt >= input.since && c.createdAt < input.until).map(c => ({ ...c }));
  }

  /** Record a captured charge (what a real provider would hold after payment). */
  recordCharge(paymentReference: string, amountMinor: number, currency: string, createdAt = new Date()): void {
    this.charges.push({
      chargeId: `fake_ch_${short(paymentReference)}`,
      paymentReference,
      amountCapturedMinor: amountMinor,
      amountRefundedMinor: 0,
      currency,
      createdAt
    });
  }
}
