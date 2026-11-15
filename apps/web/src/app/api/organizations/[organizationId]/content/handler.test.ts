import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import type { ContentItem } from "@live-competition-engine/db/paywalls";
import { createContentHandlers, type ContentServices } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";

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

const services = (): ContentServices => ({
  list: vi.fn(async () => []),
  get: vi.fn(async (_o: string, id: string) => (id === itemId ? { id, title: "T", teaser: "t", kind: "text" as const, creatorType: "account", creatorId: me, eventId: null, access: "teaser" as const, offer: { type: "members" as const } } : null)),
  create: vi.fn(async () => ({ id: itemId, accessRule: "public", status: "published" }) as unknown as ContentItem),
  purchase: vi.fn(async () => ({ order: { id: "o" } as never, redirectUrl: "https://checkout.test" })),
  orderView: order => order
});

const req = (method: string, body?: unknown, auth = true, url = "https://engine.test/api") =>
  new Request(url, { method, headers: auth ? { authorization: "Bearer t" } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("content paywall handlers", () => {
  it("serves anonymous viewers as anonymous and members with manager detection", async () => {
    const svc = services();
    const handlers = createContentHandlers(authorizer(), svc);
    expect((await handlers.get(req("GET", undefined, false), org, itemId)).status).toBe(200);
    expect(svc.get).toHaveBeenCalledWith(org, itemId, { accountId: null, isManager: false });
    await handlers.get(req("GET"), org, itemId);
    expect(svc.get).toHaveBeenLastCalledWith(org, itemId, { accountId: me, isManager: false });
    await createContentHandlers(authorizer({ manager: true }), svc).list(req("GET"), org);
    expect(svc.list).toHaveBeenCalledWith(org, { accountId: me, isManager: true }, {});
  });

  it("returns 404 for hidden, unknown or malformed items", async () => {
    const handlers = createContentHandlers(authorizer(), services());
    expect((await handlers.get(req("GET"), org, "44444444-4444-4444-8444-444444444444")).status).toBe(404);
    expect((await handlers.get(req("GET"), org, "nope")).status).toBe(404);
  });

  it("lets creators publish as themselves and requires tenant.manage otherwise", async () => {
    const svc = services();
    const ok = await createContentHandlers(authorizer(), svc).create(req("POST", { creatorType: "account", creatorId: me, title: "Hi", body: "Free post" }), org);
    expect(ok.status).toBe(201);
    const denied = await createContentHandlers(authorizer(), svc).create(req("POST", { creatorType: "tenant", title: "Hi", body: "x" }), org);
    expect(denied.status).toBe(403);
    expect((await createContentHandlers(authorizer(), svc).create(req("POST", { creatorType: "account", creatorId: me, title: "Hi", body: "x", accessRule: "purchase" }), org)).status).toBe(400);
    expect((await createContentHandlers(authorizer({ member: false }), svc).create(req("POST", { title: "x" }), org)).status).toBe(403);
  });

  it("purchases with the session account and maps disabled paywalls", async () => {
    const svc = services();
    const handlers = createContentHandlers(authorizer(), svc);
    expect((await handlers.purchase(req("POST", {}), org, itemId)).status).toBe(400);
    expect((await handlers.purchase(req("POST", { idempotencyKey: "content-buy-1" }), org, itemId)).status).toBe(201);
    expect(svc.purchase).toHaveBeenCalledWith(org, { itemId, accountId: me, idempotencyKey: "content-buy-1" });
    svc.purchase = vi.fn(async () => { throw new DomainError("feature_disabled"); });
    expect((await handlers.purchase(req("POST", { idempotencyKey: "content-buy-2" }), org, itemId)).status).toBe(403);
  });
});
