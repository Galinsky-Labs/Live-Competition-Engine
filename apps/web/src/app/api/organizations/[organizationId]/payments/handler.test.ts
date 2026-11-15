import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import type { PaymentOrder } from "@live-competition-engine/db/payments";
import { createPaymentHandlers, type PaymentServices } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const buyer = "33333333-3333-4333-8333-333333333333";
const operator = "44444444-4444-4444-8444-444444444444";

const order: PaymentOrder = {
  id: orderId, organizationId: org, accountId: buyer, eventId: null, purpose: "ticket", subjectId: null,
  payeeType: null, payeeId: null, description: "Admission", amountMinor: 1000, currency: "USD", status: "succeeded",
  settlementStatus: "settled", refundedMinor: 0, provider: "stripe", providerCheckoutReference: "cs_secret",
  providerPaymentReference: "pi_secret", failureCode: null, revision: 2, createdAt: new Date(), succeededAt: new Date()
};

const authorizer = (accountId: string, manager: boolean) => ({
  authorize: vi.fn(async () => ({ accountId, sessionId: "s", organizationId: org })),
  authorizeAction: vi.fn(async () => {
    if (!manager) throw new AuthenticationError("forbidden");
    return { accountId, sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});

const services = (): PaymentServices => ({
  getOrder: vi.fn(async (_o: string, id: string) => (id === orderId ? order : null)),
  cancelOrder: vi.fn(async () => ({ ...order, status: "cancelled" as const })),
  listRefunds: vi.fn(async () => []),
  refund: vi.fn(async () => ({ id: "r", orderId, amountMinor: 100, currency: "USD", status: "succeeded" as const, reason: "operator", providerRefundReference: "re", failureCode: null })),
  balances: vi.fn(async () => []),
  trialBalance: vi.fn(async () => ({})),
  reconcile: vi.fn(async () => ({ id: "x", checkedCount: 0, unattributedChargeCount: 0, mismatches: [] }))
});

const request = (body?: unknown, headers: Record<string, string> = {}) => new Request("https://engine.test/api", {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: "Bearer t", "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

describe("payment order handlers", () => {
  it("lets the buyer read their order without provider references", async () => {
    const response = await createPaymentHandlers(authorizer(buyer, false), services()).getOrder(request(), org, orderId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.order.amountMinor).toBe(1000);
    expect(JSON.stringify(body)).not.toContain("pi_secret");
  });

  it("denies another member who is not a manager", async () => {
    const response = await createPaymentHandlers(authorizer(operator, false), services()).getOrder(request(), org, orderId);
    expect(response.status).toBe(403);
  });

  it("returns 404 for unknown or malformed orders", async () => {
    const handlers = createPaymentHandlers(authorizer(buyer, true), services());
    expect((await handlers.getOrder(request(), org, "not-a-uuid")).status).toBe(404);
    expect((await handlers.getOrder(request(), org, "55555555-5555-4555-8555-555555555555")).status).toBe(404);
  });

  it("requires tenant.manage, an idempotency key and a valid amount to refund", async () => {
    const svc = services();
    const denied = await createPaymentHandlers(authorizer(buyer, false), svc).refund(request({ amountMinor: 100, idempotencyKey: "refund-key-1" }), org, orderId);
    expect(denied.status).toBe(403);
    const handlers = createPaymentHandlers(authorizer(operator, true), svc);
    expect((await handlers.refund(request({ amountMinor: 100 }), org, orderId)).status).toBe(400);
    expect((await handlers.refund(request({ amountMinor: -5, idempotencyKey: "refund-key-1" }), org, orderId)).status).toBe(400);
    expect((await handlers.refund(request({ reason: "nope", idempotencyKey: "refund-key-1" }), org, orderId)).status).toBe(400);
    const ok = await handlers.refund(request({ amountMinor: 100 }, { "idempotency-key": "refund-key-1" }), org, orderId);
    expect(ok.status).toBe(201);
    expect(svc.refund).toHaveBeenCalledWith(expect.objectContaining({ actorAccountId: operator, amountMinor: 100, idempotencyKey: "refund-key-1" }));
    expect(svc.refund).toHaveBeenCalledTimes(1);
  });

  it("maps domain and provider failures to stable status codes", async () => {
    const svc = services();
    svc.refund = vi.fn(async () => { throw new DomainError("refund_exceeds_remaining"); });
    const handlers = createPaymentHandlers(authorizer(operator, true), svc);
    expect((await handlers.refund(request({ idempotencyKey: "refund-key-2" }), org, orderId)).status).toBe(409);
    svc.refund = vi.fn(async () => { throw Object.assign(new Error("stripe is not configured"), { code: "provider_not_configured" }); });
    expect((await handlers.refund(request({ idempotencyKey: "refund-key-3" }), org, orderId)).status).toBe(503);
  });

  it("exposes ledger balances and reconciliation to managers only", async () => {
    expect((await createPaymentHandlers(authorizer(buyer, false), services()).ledger(request(), org)).status).toBe(403);
    const handlers = createPaymentHandlers(authorizer(operator, true), services());
    expect((await handlers.ledger(request(), org)).status).toBe(200);
    expect((await handlers.reconcile(request({ since: "bad" }), org)).status).toBe(400);
    expect((await handlers.reconcile(request({ since: "2026-11-01T00:00:00Z" }), org)).status).toBe(201);
  });
});
