import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createSplitHandlers, type SplitServices } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const ruleId = "33333333-3333-4333-8333-333333333333";

const authorizer = (manager: boolean) => ({
  authorize: vi.fn(async () => ({ accountId: "a", sessionId: "s", organizationId: org })),
  authorizeAction: vi.fn(async () => {
    if (!manager) throw new AuthenticationError("forbidden");
    return { accountId: "op", sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});

const services = (): SplitServices => ({
  list: vi.fn(async () => []),
  create: vi.fn(async () => ({ id: ruleId, organizationId: org, eventId: null, purpose: null, version: 1, lines: [], remainderLine: 0, createdAt: new Date() })),
  adjust: vi.fn(async () => ({ ledgerTransactionId: "t", allocations: [] })),
  statement: vi.fn(async () => ({ accountCode: "tenant_revenue", currency: "USD", openingBalanceMinor: 0, closingBalanceMinor: -5, owedMinor: 5, lines: [] })),
  accountCode: vi.fn((type: string) => { if (type !== "tenant") throw new DomainError("invalid_split_party"); return "tenant_revenue"; })
});

const post = (body: unknown) => new Request("https://engine.test/api", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });
const get = (query = "") => new Request(`https://engine.test/api${query}`, { headers: { authorization: "Bearer t" } });

describe("revenue split handlers", () => {
  it("publishes a rule version for managers", async () => {
    const svc = services();
    const response = await createSplitHandlers(authorizer(true), svc).create(post({ purpose: "tip", lines: [{ partyType: "tenant" }] }), org);
    expect(response.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(org, expect.objectContaining({ purpose: "tip" }), "op");
  });

  it("forbids non-managers", async () => {
    const svc = services();
    expect((await createSplitHandlers(authorizer(false), svc).create(post({ lines: [] }), org)).status).toBe(403);
    expect((await createSplitHandlers(authorizer(false), svc).statement(get(), org)).status).toBe(403);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("validates input and maps rule errors", async () => {
    const svc = services();
    const handlers = createSplitHandlers(authorizer(true), svc);
    expect((await handlers.create(post({ purpose: "bribe", lines: [] }), org)).status).toBe(400);
    expect((await handlers.create(post({ eventId: "x", lines: [] }), org)).status).toBe(400);
    svc.create = vi.fn(async () => { throw new DomainError("invalid_split_bps"); });
    expect((await handlers.create(post({ lines: [{ partyType: "platform", bps: 99999 }] }), org)).status).toBe(400);
    expect((await handlers.adjust(post({ ruleId: "nope" }), org, orderId)).status).toBe(400);
    expect((await handlers.statement(get("?partyType=nobody&currency=USD"), org)).status).toBe(400);
  });

  it("returns 404 for unknown orders on adjustment", async () => {
    const svc = services();
    svc.adjust = vi.fn(async () => { throw new DomainError("order_not_found"); });
    const handlers = createSplitHandlers(authorizer(true), svc);
    expect((await handlers.adjust(post({ ruleId }), org, "bad")).status).toBe(404);
    expect((await handlers.adjust(post({ ruleId }), org, orderId)).status).toBe(404);
  });

  it("returns payout statements", async () => {
    const response = await createSplitHandlers(authorizer(true), services()).statement(get("?partyType=tenant&currency=USD"), org);
    expect(response.status).toBe(200);
    expect((await response.json()).statement.owedMinor).toBe(5);
  });
});
