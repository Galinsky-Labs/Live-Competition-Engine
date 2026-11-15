import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import type { TicketType } from "@live-competition-engine/db/ticketing";
import { createTicketingHandlers, type TicketingServices } from "./handlers";
import { createPaymentJobHandler } from "../../../../../platform/jobs/payments/handler";

const org = "11111111-1111-4111-8111-111111111111";
const event = "22222222-2222-4222-8222-222222222222";
const typeId = "33333333-3333-4333-8333-333333333333";

const type: TicketType = {
  id: typeId, organizationId: org, eventId: event, kind: "ticket", name: "GA", priceMinor: 1500, currency: "USD",
  capacity: 10, reserved: 0, salesStartsAt: null, salesEndsAt: null, status: "on_sale", revision: 1
};

const authorizer = (opts: { member?: boolean; producer?: boolean } = {}) => ({
  authorize: vi.fn(async (header: string | null) => {
    if (!header) throw new AuthenticationError("missing");
    if (opts.member === false) throw new AuthenticationError("forbidden");
    return { accountId: "buyer", sessionId: "s", organizationId: org };
  }),
  authorizeAction: vi.fn(async () => {
    if (!opts.producer) throw new AuthenticationError("forbidden");
    return { accountId: "producer", sessionId: "s", organizationId: org, role: "event_producer" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});

const services = (): TicketingServices => ({
  list: vi.fn(async () => [type]),
  view: t => ({ id: (t as TicketType).id, priceMinor: (t as TicketType).priceMinor }),
  create: vi.fn(async () => type),
  setStatus: vi.fn(async () => ({ ...type, status: "paused" as const })),
  purchase: vi.fn(async () => ({ order: { id: "o" } as never, redirectUrl: "https://checkout.test/x" })),
  access: vi.fn(async () => ({ gated: true, allowed: false })),
  entryFeeGate: vi.fn(async () => ({ required: false as const })),
  setEntryFee: vi.fn(async () => ({ competitionId: event, priceMinor: 100, currency: "USD", active: true, revision: 1 })),
  purchaseEntryFee: vi.fn(async () => ({ order: { id: "o" } as never, redirectUrl: null })),
  orderView: order => order
});

const req = (method: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer t" }, url = "https://engine.test/api") =>
  new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("ticketing handlers", () => {
  it("lets producers create ticket types and validates input", async () => {
    const svc = services();
    const handlers = createTicketingHandlers(authorizer({ producer: true }), svc);
    const ok = await handlers.create(req("POST", { name: "GA", priceMinor: 1500, currency: "usd", capacity: 10 }), org, event);
    expect(ok.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(org, event, expect.objectContaining({ currency: "USD", capacity: 10 }), "producer");
    expect((await handlers.create(req("POST", { name: "GA", priceMinor: -1, currency: "usd" }), org, event)).status).toBe(400);
    expect((await handlers.create(req("POST", { name: "", priceMinor: 1, currency: "usd" }), org, event)).status).toBe(400);
  });

  it("forbids non-producers from creating or pausing ticket types", async () => {
    const svc = services();
    const handlers = createTicketingHandlers(authorizer({ producer: false }), svc);
    expect((await handlers.create(req("POST", { name: "GA", priceMinor: 1, currency: "usd" }), org, event)).status).toBe(403);
    expect((await handlers.update(req("PATCH", { status: "paused", expectedRevision: 1 }), org, event, typeId)).status).toBe(403);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("purchases with the authenticated account and requires an idempotency key", async () => {
    const svc = services();
    const handlers = createTicketingHandlers(authorizer(), svc);
    expect((await handlers.purchase(req("POST", {}), org, event, typeId)).status).toBe(400);
    const ok = await handlers.purchase(req("POST", { idempotencyKey: "purchase-1", accountId: "attacker" }), org, event, typeId);
    expect(ok.status).toBe(201);
    expect(svc.purchase).toHaveBeenCalledWith(org, expect.objectContaining({ accountId: "buyer", ticketTypeId: typeId }));
    expect((await handlers.purchase(req("POST", { idempotencyKey: "purchase-1" }), org, event, "nope")).status).toBe(404);
    expect((await createTicketingHandlers(authorizer({ member: false }), svc).purchase(req("POST", { idempotencyKey: "purchase-1" }), org, event, typeId)).status).toBe(403);
  });

  it("maps sold out, disabled features and missing ticket types", async () => {
    const svc = services();
    const handlers = createTicketingHandlers(authorizer(), svc);
    for (const [code, status] of [["sold_out", 409], ["feature_disabled", 403], ["ticket_type_not_found", 404], ["provider_not_configured", 503]] as const) {
      svc.purchase = vi.fn(async () => { throw new DomainError(code); });
      expect((await handlers.purchase(req("POST", { idempotencyKey: "purchase-2" }), org, event, typeId)).status).toBe(status);
    }
  });

  it("answers the access gate anonymously and validates mode", async () => {
    const svc = services();
    const handlers = createTicketingHandlers(authorizer(), svc);
    const anonymous = await handlers.access(req("GET", undefined, {}, "https://engine.test/api?mode=view"), org, event);
    expect(anonymous.status).toBe(200);
    expect(svc.access).toHaveBeenCalledWith(org, event, null, "view");
    expect((await handlers.access(req("GET", undefined, {}, "https://engine.test/api?mode=x"), org, event)).status).toBe(400);
  });

  it("configures entry fees for producers only", async () => {
    const svc = services();
    expect((await createTicketingHandlers(authorizer(), svc).configureEntryFee(req("PUT", { priceMinor: 100, currency: "USD", expectedRevision: 0 }), org, event)).status).toBe(403);
    const handlers = createTicketingHandlers(authorizer({ producer: true }), svc);
    expect((await handlers.configureEntryFee(req("PUT", { priceMinor: 0, currency: "USD", expectedRevision: 0 }), org, event)).status).toBe(400);
    expect((await handlers.configureEntryFee(req("PUT", { priceMinor: 100, currency: "USD", expectedRevision: 0 }), org, event)).status).toBe(200);
    expect((await handlers.entryFee(req("GET"), org, event)).status).toBe(200);
  });
});

describe("payment maintenance job", () => {
  it("requires the job secret", async () => {
    const task = vi.fn(async () => 2);
    const handler = createPaymentJobHandler({ verify: header => header === "Bearer secret", tasks: { releasedHolds: task } });
    expect((await handler(req("POST", undefined, {}))).status).toBe(401);
    const ok = await handler(req("POST", undefined, { authorization: "Bearer secret" }));
    expect((await ok.json()).results.releasedHolds).toBe(2);
  });
});
