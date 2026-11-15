import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import type { MembershipPlan, Subscription } from "@live-competition-engine/db/subscriptions";
import { createSubscriptionHandlers, type SubscriptionServices } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const me = "22222222-2222-4222-8222-222222222222";
const planId = "33333333-3333-4333-8333-333333333333";
const subId = "44444444-4444-4444-8444-444444444444";

const plan: MembershipPlan = {
  id: planId, organizationId: org, creatorType: "account", creatorId: me, name: "Supporters", description: "", priceMinor: 500,
  currency: "USD", interval: "month", termsVersion: "v1", status: "active", revision: 1
};
const sub: Subscription = {
  id: subId, organizationId: org, planId, accountId: me, status: "active", currentPeriodStart: new Date(), currentPeriodEnd: new Date(),
  cancelAtPeriodEnd: false, consentTermsVersion: "v1", consentAt: new Date(), provider: "stripe", providerSubscriptionId: "sub_secret", revision: 1
};

const authorizer = (accountId: string, manager = false) => ({
  authorize: vi.fn(async () => ({ accountId, sessionId: "s", organizationId: org })),
  authorizeAction: vi.fn(async () => {
    if (!manager) throw new AuthenticationError("forbidden");
    return { accountId, sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});

const services = (): SubscriptionServices => ({
  listPlans: vi.fn(async () => [plan]),
  createPlan: vi.fn(async () => plan),
  archivePlan: vi.fn(async () => ({ ...plan, status: "archived" as const })),
  subscribe: vi.fn(async () => ({ subscription: { ...sub, status: "incomplete" as const }, redirectUrl: "https://checkout.test" })),
  listMine: vi.fn(async () => [sub]),
  get: vi.fn(async (_o: string, id: string) => (id === subId ? sub : null)),
  cancel: vi.fn(async () => ({ ...sub, cancelAtPeriodEnd: true }))
});

const post = (body: unknown) => new Request("https://engine.test/api", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });
const planBody = (creatorType: string, creatorId: string | null) => ({ creatorType, creatorId, name: "P", priceMinor: 500, currency: "usd", interval: "month", termsVersion: "v1" });

describe("membership plan and subscription handlers", () => {
  it("lets a creator offer their own plan but requires tenant.manage for others", async () => {
    const svc = services();
    expect((await createSubscriptionHandlers(authorizer(me), svc).createPlan(post(planBody("account", me)), org)).status).toBe(201);
    expect((await createSubscriptionHandlers(authorizer(me), svc).createPlan(post(planBody("account", subId)), org)).status).toBe(403);
    expect((await createSubscriptionHandlers(authorizer(me), svc).createPlan(post(planBody("tenant", null)), org)).status).toBe(403);
    expect((await createSubscriptionHandlers(authorizer(me, true), svc).createPlan(post(planBody("tenant", null)), org)).status).toBe(201);
    expect(svc.createPlan).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid plans", async () => {
    const handlers = createSubscriptionHandlers(authorizer(me), services());
    expect((await handlers.createPlan(post({ ...planBody("account", me), interval: "week" }), org)).status).toBe(400);
    expect((await handlers.createPlan(post({ ...planBody("account", me), priceMinor: 0 }), org)).status).toBe(400);
  });

  it("subscribes the authenticated account and surfaces consent errors", async () => {
    const svc = services();
    const handlers = createSubscriptionHandlers(authorizer(me), svc);
    expect((await handlers.subscribe(post({ consent: { accepted: true } }), org, planId)).status).toBe(400);
    const ok = await handlers.subscribe(post({ idempotencyKey: "subscribe-1", consent: { accepted: true } }), org, planId);
    expect(ok.status).toBe(201);
    expect(svc.subscribe).toHaveBeenCalledWith(org, expect.objectContaining({ accountId: me, planId }));
    expect(JSON.stringify(await ok.json())).not.toContain("sub_secret");
    svc.subscribe = vi.fn(async () => { throw new DomainError("consent_required"); });
    expect((await handlers.subscribe(post({ idempotencyKey: "subscribe-2" }), org, planId)).status).toBe(400);
    svc.subscribe = vi.fn(async () => { throw new DomainError("feature_disabled"); });
    expect((await handlers.subscribe(post({ idempotencyKey: "subscribe-3" }), org, planId)).status).toBe(403);
    expect((await handlers.subscribe(post({ idempotencyKey: "subscribe-4" }), org, "bad")).status).toBe(404);
  });

  it("only the subscriber or a manager can cancel", async () => {
    const svc = services();
    expect((await createSubscriptionHandlers(authorizer(planId), svc).cancel(post({}), org, subId)).status).toBe(403);
    expect((await createSubscriptionHandlers(authorizer(me), svc).cancel(post({}), org, "55555555-5555-4555-8555-555555555555")).status).toBe(404);
    const ok = await createSubscriptionHandlers(authorizer(me), svc).cancel(post({ atPeriodEnd: true }), org, subId);
    expect(ok.status).toBe(200);
    expect(svc.cancel).toHaveBeenCalledWith(org, subId, { atPeriodEnd: true, actorAccountId: me });
  });
});
