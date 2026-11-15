import { DomainError } from "./index.ts";

/** Payment order lifecycle. Terminal states never transition again. */
export const paymentOrderStatuses = ["requires_payment", "processing", "succeeded", "failed", "cancelled"] as const;
export type PaymentOrderStatus = (typeof paymentOrderStatuses)[number];

export const settlementStatuses = ["unsettled", "settled", "partially_refunded", "refunded"] as const;
export type SettlementStatus = (typeof settlementStatuses)[number];

export const refundStatuses = ["pending", "succeeded", "failed"] as const;
export type RefundStatus = (typeof refundStatuses)[number];

export const paymentPurposes = ["ticket", "ppv", "entry_fee", "subscription", "tip", "gift", "content"] as const;
export type PaymentPurpose = (typeof paymentPurposes)[number];

const orderTransitions: Readonly<Record<PaymentOrderStatus, readonly PaymentOrderStatus[]>> = {
  requires_payment: ["processing", "succeeded", "failed", "cancelled"],
  processing: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: []
};

const refundTransitions: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  pending: ["succeeded", "failed"],
  succeeded: [],
  failed: []
};

export function canTransitionOrder(from: PaymentOrderStatus, to: PaymentOrderStatus): boolean {
  return orderTransitions[from]?.includes(to) ?? false;
}

export function assertOrderTransition(from: PaymentOrderStatus, to: PaymentOrderStatus): void {
  if (!canTransitionOrder(from, to)) throw new DomainError("invalid_state_transition");
}

export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (!(refundTransitions[from]?.includes(to) ?? false)) throw new DomainError("invalid_state_transition");
}

/**
 * Remaining refundable amount: the captured amount minus refunds that already
 * succeeded or are still pending (pending refunds reserve their amount).
 */
export function refundableAmount(amountMinor: number, refunds: readonly { amountMinor: number; status: RefundStatus }[]): number {
  const reserved = refunds.filter(r => r.status !== "failed").reduce((sum, r) => sum + r.amountMinor, 0);
  return Math.max(0, amountMinor - reserved);
}

export function settlementAfterRefund(amountMinor: number, refundedMinor: number): SettlementStatus {
  if (refundedMinor <= 0) return "settled";
  return refundedMinor >= amountMinor ? "refunded" : "partially_refunded";
}

/** Idempotency keys come from clients; keep them short and printable. */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{8,120}$/.test(value);
}
