import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createTipHandlers, type TipServices } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const event = "22222222-2222-4222-8222-222222222222";
const payee = "33333333-3333-4333-8333-333333333333";
const me = "44444444-4444-4444-8444-444444444444";

const authorizer = (opts: { member?: boolean; manager?: boolean } = {}) => ({
  authorize: vi.fn(async () => {
    if (opts.member === false) throw new AuthenticationError("forbidden");
    return { accountId: me, sessionId: "s", organizationId: org };
  }),
  authorizeAction: vi.fn(async () => {
    if (!opts.manager) throw new AuthenticationError("forbidden");
    return { accountId: me, sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});

const quote = { grossMinor: 1000, payeeMinor: 900, fees: [{ partyType: "platform", partyId: null, amountMinor: 100 }], currency: "USD", ruleVersion: 1, giftId: null, quantity: 1 };
const services = (): TipServices => ({
  listGifts: vi.fn(async () => []),
  createGift: vi.fn(async () => ({ id: "g", name: "Rose", priceMinor: 300, currency: "USD", active: true, revision: 1 })),
  setPolicy: vi.fn(async policy => policy),
  linkPayout: vi.fn(async () => {}),
  quote: vi.fn(async () => quote),
  send: vi.fn(async () => ({ tipId: "t", order: { id: "o" } as never, redirectUrl: "https://checkout.test" })),
  feed: vi.fn(async () => []),
  orderView: order => order
});

const post = (body: unknown) => new Request("https://engine.test/api", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });
const tipBody = { payeeType: "participant", payeeId: payee, amountMinor: 1000, currency: "USD" };

describe("tip handlers", () => {
  it("returns a fee breakdown before confirmation", async () => {
    const svc = services();
    const response = await createTipHandlers(authorizer(), svc).quote(post(tipBody), org, event);
    expect(response.status).toBe(200);
    expect((await response.json()).quote.fees[0].amountMinor).toBe(100);
    expect(svc.quote).toHaveBeenCalledWith(org, expect.objectContaining({ eventId: event, payeeId: payee }), me);
  });

  it("requires an accepted quote and idempotency key, and uses the session sender", async () => {
    const svc = services();
    const handlers = createTipHandlers(authorizer(), svc);
    expect((await handlers.send(post({ ...tipBody, idempotencyKey: "tip-key-01" }), org, event)).status).toBe(400);
    expect((await handlers.send(post({ ...tipBody, acceptedQuote: quote }), org, event)).status).toBe(400);
    const ok = await handlers.send(post({ ...tipBody, acceptedQuote: quote, idempotencyKey: "tip-key-01", senderAccountId: payee }), org, event);
    expect(ok.status).toBe(201);
    expect(svc.send).toHaveBeenCalledWith(org, expect.objectContaining({ senderAccountId: me, expected: { grossMinor: 1000, payeeMinor: 900 } }));
  });

  it("maps abuse controls to clear statuses", async () => {
    const svc = services();
    const handlers = createTipHandlers(authorizer(), svc);
    for (const [code, status] of [["self_tip_forbidden", 403], ["rate_limited", 429], ["quote_changed", 409], ["feature_disabled", 403], ["payee_not_found", 404], ["tip_amount_out_of_range", 400]] as const) {
      svc.send = vi.fn(async () => { throw new DomainError(code); });
      expect((await handlers.send(post({ ...tipBody, acceptedQuote: quote, idempotencyKey: "tip-key-02" }), org, event)).status).toBe(status);
    }
  });

  it("rejects invalid input and non-members", async () => {
    const handlers = createTipHandlers(authorizer(), services());
    expect((await handlers.quote(post({ ...tipBody, payeeType: "nobody" }), org, event)).status).toBe(400);
    expect((await handlers.quote(post(tipBody), org, "bad")).status).toBe(404);
    expect((await createTipHandlers(authorizer({ member: false }), services()).quote(post(tipBody), org, event)).status).toBe(403);
  });

  it("restricts catalog, policy and payout administration to managers", async () => {
    const svc = services();
    const user = createTipHandlers(authorizer(), svc);
    expect((await user.createGift(post({ name: "Rose", priceMinor: 300, currency: "USD" }), org)).status).toBe(403);
    expect((await user.setPolicy(post({}), org)).status).toBe(403);
    const admin = createTipHandlers(authorizer({ manager: true }), svc);
    expect((await admin.createGift(post({ name: "Rose", priceMinor: 300, currency: "USD" }), org)).status).toBe(201);
    expect((await admin.setPolicy(post({ minMinor: 500, maxMinor: 100, windowSeconds: 60, maxCountPerWindow: 1, maxAmountPerWindowMinor: 100 }), org)).status).toBe(400);
    expect((await admin.linkPayout(post({ accountId: me }), org, payee)).status).toBe(200);
    expect((await admin.linkPayout(post({ accountId: "x" }), org, payee)).status).toBe(400);
  });
});
