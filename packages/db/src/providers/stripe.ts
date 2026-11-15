import { createHmac, timingSafeEqual } from "node:crypto";
import { requireStripe } from "@live-competition-engine/config/providers";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import type {
  CheckoutInput,
  CheckoutSession,
  PaymentEvent,
  PaymentProvider,
  ProviderCharge,
  ProviderRefund,
  RefundInput,
  SubscriptionCheckoutInput
} from "./payments.ts";

const STRIPE_API = "https://api.stripe.com/v1";
/** Pinned so request/response shapes are stable; create the webhook endpoint with the same version. */
export const STRIPE_API_VERSION = "2024-06-20";
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

type FormValue = string | number | boolean | null | undefined | FormObject | FormValue[];
interface FormObject { [key: string]: FormValue }

/** Stripe-style bracket form encoding: a[b][0][c]=v. Undefined/null values are omitted. */
export function formEncode(value: FormObject): string {
  const params = new URLSearchParams();
  const walk = (prefix: string, v: FormValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) { v.forEach((item, index) => walk(`${prefix}[${index}]`, item)); return; }
    if (typeof v === "object") { for (const [k, inner] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, inner); return; }
    params.append(prefix, String(v));
  };
  walk("", value);
  return params.toString();
}

/**
 * Verify a `Stripe-Signature` header (t=<unix>,v1=<hex>[,v1=...]) as an
 * HMAC-SHA256 over `${t}.${rawBody}` with the endpoint secret, constant-time,
 * rejecting timestamps outside the tolerance window (replay protection).
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = STRIPE_SIGNATURE_TOLERANCE_SECONDS
): boolean {
  if (!header || header.length > 2048 || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t" && /^[0-9]{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  return signatures.some(signature => {
    const candidate = Buffer.from(signature, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

/** Build a header for tests and tooling (same algorithm Stripe uses). */
export function signStripePayload(rawBody: string, secret: string, timestampSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestampSeconds},v1=${v1}`;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= 255 ? value : null);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const ref = (value: unknown): string | null => str(value) ?? str(obj(value).id);
const uuidOrNull = (value: unknown): string | null => (isUuid(value) ? value : null);

/**
 * Map a verified Stripe event to an engine PaymentEvent, or null when the event
 * type is not one the engine acts on (it is still stored for replay protection).
 */
export function normalizeStripeEvent(event: Json): PaymentEvent | null {
  const type = str(event.type);
  const object = obj(obj(event.data).object);
  const metadata = obj(object.metadata);
  const organizationId = uuidOrNull(metadata.organization_id);
  const orderId = uuidOrNull(metadata.order_id);
  const subscriptionId = uuidOrNull(metadata.subscription_id);
  const mode = str(object.mode);
  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (mode === "subscription") {
        const providerSubscriptionId = ref(object.subscription);
        if (!organizationId || !subscriptionId || !providerSubscriptionId) return null;
        return { kind: "subscription_checkout_completed", organizationId, subscriptionId, providerSubscriptionId };
      }
      const paid = str(object.payment_status);
      const paymentReference = ref(object.payment_intent);
      const amountMinor = int(object.amount_total);
      const currency = str(object.currency);
      if (paid !== "paid" || !organizationId || !orderId || !paymentReference || amountMinor === null || !currency) return null;
      return { kind: "payment_succeeded", organizationId, orderId, paymentReference, amountMinor, currency: currency.toUpperCase() };
    }
    case "checkout.session.async_payment_failed":
      if (!organizationId || !orderId) return null;
      return { kind: "payment_failed", organizationId, orderId, failureCode: "async_payment_failed" };
    case "checkout.session.expired":
      if (mode === "subscription") {
        if (!organizationId || !subscriptionId) return null;
        return { kind: "subscription_checkout_expired", organizationId, subscriptionId };
      }
      if (!organizationId || !orderId) return null;
      return { kind: "payment_cancelled", organizationId, orderId };
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated": {
      const refundId = uuidOrNull(metadata.refund_id);
      const providerRefundReference = str(object.id);
      const status = str(object.status);
      if (!organizationId || !refundId || !providerRefundReference) return null;
      const mapped = status === "succeeded" ? "succeeded" : status === "failed" || status === "canceled" ? "failed" : "pending";
      return { kind: "refund_updated", organizationId, refundId, providerRefundReference, status: mapped };
    }
    case "charge.dispute.created": {
      const paymentReference = ref(object.payment_intent);
      const amountMinor = int(object.amount);
      const currency = str(object.currency);
      const disputeId = str(object.id);
      if (!paymentReference || amountMinor === null || amountMinor === 0 || !currency || !disputeId) return null;
      return { kind: "chargeback", paymentReference, amountMinor, currency: currency.toUpperCase(), disputeId };
    }
    case "invoice.paid": {
      const parent = obj(obj(object.parent).subscription_details);
      const providerSubscriptionId = ref(object.subscription) ?? ref(parent.subscription);
      const invoiceId = str(object.id);
      const amountMinor = int(object.amount_paid);
      const currency = str(object.currency);
      const lines = obj(object.lines).data;
      const period = obj(obj(Array.isArray(lines) ? lines[0] : undefined).period);
      const start = int(period.start) ?? int(object.period_start);
      const end = int(period.end) ?? int(object.period_end);
      if (!providerSubscriptionId || !invoiceId || amountMinor === null || !currency || start === null || end === null || end <= start) return null;
      return {
        kind: "invoice_paid", providerSubscriptionId, invoiceId, paymentReference: ref(object.payment_intent),
        amountMinor, currency: currency.toUpperCase(), periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000)
      };
    }
    case "invoice.payment_failed": {
      const parent = obj(obj(object.parent).subscription_details);
      const providerSubscriptionId = ref(object.subscription) ?? ref(parent.subscription);
      const invoiceId = str(object.id);
      if (!providerSubscriptionId || !invoiceId) return null;
      return { kind: "invoice_payment_failed", providerSubscriptionId, invoiceId };
    }
    case "customer.subscription.deleted": {
      const providerSubscriptionId = str(object.id);
      if (!providerSubscriptionId) return null;
      return { kind: "subscription_ended", providerSubscriptionId };
    }
    default:
      return null;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Real Stripe adapter over `fetch`. Fails closed when credentials are missing. */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  private readonly secretKey: string;
  private readonly fetcher: FetchLike;

  constructor(options: { secretKey?: string; fetcher?: FetchLike } = {}) {
    this.secretKey = options.secretKey ?? requireStripe().secretKey;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: FormObject, idempotencyKey?: string): Promise<Json> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      "stripe-version": STRIPE_API_VERSION
    };
    let url = `${STRIPE_API}${path}`;
    let payload: string | undefined;
    if (body && method === "GET") url += `?${formEncode(body)}`;
    else if (body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = formEncode(body);
    }
    if (idempotencyKey && method !== "GET") headers["idempotency-key"] = idempotencyKey;
    let response: Response;
    try {
      response = await this.fetcher(url, { method, headers, ...(payload ? { body: payload } : {}), signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new DomainError("provider_unavailable");
    }
    let json: Json;
    try {
      json = obj(await response.json());
    } catch {
      throw new DomainError("provider_unavailable");
    }
    if (!response.ok) {
      const code = str(obj(json.error).code);
      throw new DomainError(response.status >= 500 || response.status === 429 ? "provider_unavailable"
        : code === "charge_already_refunded" ? "refund_conflict" : "provider_rejected");
    }
    return json;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const metadata = { order_id: input.orderId, organization_id: input.organizationId };
    const session = await this.call("POST", "/checkout/sessions", {
      mode: "payment",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.orderId,
      line_items: [{ quantity: 1, price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amountMinor, product_data: { name: input.description } } }],
      metadata,
      payment_intent_data: { metadata }
    }, input.idempotencyKey);
    const reference = str(session.id);
    const redirectUrl = str(session.url) ?? (typeof session.url === "string" ? session.url : null);
    if (!reference || !redirectUrl) throw new DomainError("provider_rejected");
    return { reference, redirectUrl };
  }

  async createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<CheckoutSession> {
    const metadata = { subscription_id: input.subscriptionId, organization_id: input.organizationId };
    const session = await this.call("POST", "/checkout/sessions", {
      mode: "subscription",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.subscriptionId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(), unit_amount: input.amountMinor,
          recurring: { interval: input.interval }, product_data: { name: input.description }
        }
      }],
      metadata,
      subscription_data: { metadata }
    }, input.idempotencyKey);
    const reference = str(session.id);
    const redirectUrl = typeof session.url === "string" ? session.url : null;
    if (!reference || !redirectUrl) throw new DomainError("provider_rejected");
    return { reference, redirectUrl };
  }

  async refund(input: RefundInput): Promise<ProviderRefund> {
    const refund = await this.call("POST", "/refunds", {
      payment_intent: input.paymentReference,
      amount: input.amountMinor,
      metadata: { refund_id: input.refundId, organization_id: input.organizationId }
    }, input.idempotencyKey);
    const reference = str(refund.id);
    if (!reference) throw new DomainError("provider_rejected");
    const status = str(refund.status);
    return { reference, status: status === "succeeded" ? "succeeded" : status === "failed" || status === "canceled" ? "failed" : "pending" };
  }

  async cancelSubscription(input: { providerSubscriptionId: string; atPeriodEnd: boolean; idempotencyKey: string }): Promise<void> {
    const path = `/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`;
    if (input.atPeriodEnd) await this.call("POST", path, { cancel_at_period_end: true }, input.idempotencyKey);
    else await this.call("DELETE", path, undefined, input.idempotencyKey);
  }

  async listCharges(input: { since: Date; until: Date }): Promise<ProviderCharge[]> {
    const charges: ProviderCharge[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.call("GET", "/charges", {
        limit: 100,
        created: { gte: Math.floor(input.since.getTime() / 1000), lt: Math.floor(input.until.getTime() / 1000) },
        ...(startingAfter ? { starting_after: startingAfter } : {})
      });
      const data = Array.isArray(result.data) ? result.data.map(obj) : [];
      for (const charge of data) {
        const chargeId = str(charge.id);
        const currency = str(charge.currency);
        if (!chargeId || !currency || charge.status !== "succeeded") continue;
        charges.push({
          chargeId,
          paymentReference: ref(charge.payment_intent),
          amountCapturedMinor: int(charge.amount_captured) ?? 0,
          amountRefundedMinor: int(charge.amount_refunded) ?? 0,
          currency: currency.toUpperCase(),
          createdAt: new Date((int(charge.created) ?? 0) * 1000)
        });
      }
      if (result.has_more !== true || data.length === 0) break;
      startingAfter = str(data[data.length - 1]!.id) ?? undefined;
      if (!startingAfter) break;
    }
    return charges;
  }
}
