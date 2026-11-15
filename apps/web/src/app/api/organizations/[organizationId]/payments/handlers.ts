import type { LedgerBalance, PaymentOrder, ReconciliationReport, RefundReason, RefundView } from "@live-competition-engine/db/payments";
import { errorResponse, isUuid, json, readJsonObject, requireAction } from "../../../../../lib/http";
import { guarded, idempotencyKeyOf, intField, requireOwnerOrManager, type MonetizationAuthorizer } from "../../../../../lib/monetization-http";

export interface PaymentServices {
  getOrder(organizationId: string, orderId: string): Promise<PaymentOrder | null>;
  cancelOrder(organizationId: string, orderId: string): Promise<PaymentOrder>;
  listRefunds(organizationId: string, orderId: string): Promise<RefundView[]>;
  refund(input: { organizationId: string; orderId: string; amountMinor?: number; reason: RefundReason; actorAccountId: string; idempotencyKey: string }): Promise<RefundView>;
  balances(organizationId: string): Promise<LedgerBalance[]>;
  trialBalance(organizationId: string): Promise<Record<string, number>>;
  reconcile(organizationId: string, window: { since: Date; until: Date; actorAccountId: string }): Promise<ReconciliationReport>;
}

const refundReasons = ["requested_by_customer", "operator", "event_cancelled", "fraud"];

/** Client order projection: no provider references or internal fingerprints. */
export function orderView(order: PaymentOrder) {
  return {
    id: order.id, purpose: order.purpose, eventId: order.eventId, subjectId: order.subjectId,
    description: order.description, amountMinor: order.amountMinor, currency: order.currency,
    status: order.status, settlementStatus: order.settlementStatus, refundedMinor: order.refundedMinor,
    failureCode: order.failureCode, createdAt: order.createdAt, succeededAt: order.succeededAt
  };
}

export function createPaymentHandlers(authorizer: MonetizationAuthorizer, services: PaymentServices) {
  const ownerOf = (organizationId: string, orderId: string) => async () =>
    isUuid(orderId) ? (await services.getOrder(organizationId, orderId))?.accountId ?? null : null;

  return {
    async getOrder(request: Request, organizationId: string, orderId: string) {
      const principal = await requireOwnerOrManager(authorizer, request, organizationId, ownerOf(organizationId, orderId));
      if (principal instanceof Response) return principal;
      const order = await services.getOrder(organizationId, orderId);
      if (!order) return errorResponse(404, "order_not_found");
      return json({ order: orderView(order), refunds: await services.listRefunds(organizationId, orderId) });
    },

    async cancelOrder(request: Request, organizationId: string, orderId: string) {
      const principal = await requireOwnerOrManager(authorizer, request, organizationId, ownerOf(organizationId, orderId));
      if (principal instanceof Response) return principal;
      return guarded(async () => json({ order: orderView(await services.cancelOrder(organizationId, orderId)) }));
    },

    async refund(request: Request, organizationId: string, orderId: string) {
      const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
      if (principal instanceof Response) return principal;
      if (!isUuid(orderId)) return errorResponse(404, "order_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const idempotencyKey = idempotencyKeyOf(request, body);
      const amountMinor = intField(body, "amountMinor");
      const reason = body.reason ?? "operator";
      if (!idempotencyKey) return errorResponse(400, "invalid_idempotency_key");
      if (amountMinor === null || (amountMinor !== undefined && amountMinor <= 0)) return errorResponse(400, "invalid_amount");
      if (typeof reason !== "string" || !refundReasons.includes(reason)) return errorResponse(400, "invalid_refund_reason");
      return guarded(async () => {
        const refund = await services.refund({
          organizationId, orderId, ...(amountMinor !== undefined ? { amountMinor } : {}),
          reason: reason as RefundReason, actorAccountId: principal.accountId, idempotencyKey
        });
        return json({ refund }, refund.status === "pending" ? 202 : 201);
      });
    },

    async ledger(request: Request, organizationId: string) {
      const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
      if (principal instanceof Response) return principal;
      return json({ accounts: await services.balances(organizationId), trialBalance: await services.trialBalance(organizationId) });
    },

    async reconcile(request: Request, organizationId: string) {
      const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const since = typeof body.since === "string" ? new Date(body.since) : null;
      const until = typeof body.until === "string" ? new Date(body.until) : new Date();
      if (!since || Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return errorResponse(400, "invalid_window");
      return guarded(async () => json({ report: await services.reconcile(organizationId, { since, until, actorAccountId: principal.accountId }) }, 201));
    }
  };
}
