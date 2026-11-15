import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createPlatformSubscriptionStatusHandler, createSubscriptionHandlers, type SubscriptionDeps } from "./handler";
import { createPlanAdminHandlers } from "../../../platform/plans/handler";

const org = "11111111-1111-4111-8111-111111111111";
const planId = "22222222-2222-4222-8222-222222222222";
const principal = { accountId: "acct", sessionId: "sess", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
const allow = { authorizeAction: vi.fn(async () => principal) };
const deny = { authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };
const req = (body?: unknown, url = "https://engine.test/api") => new Request(url, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: "Bearer x", "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

function deps(overrides: Partial<SubscriptionDeps> = {}): SubscriptionDeps {
  return {
    get: vi.fn(async () => null),
    start: vi.fn(async () => ({ subscription: { id: "s" }, change: { id: "c" }, replayed: false }) as never),
    change: vi.fn(async () => ({ outcome: "applied", subscription: { id: "s" }, change: { netMinor: 10 }, replayed: false }) as never),
    cancelPendingDowngrade: vi.fn(async () => ({ id: "s" }) as never),
    setStatus: vi.fn(async () => ({ id: "s", status: "cancelled" }) as never),
    aggregateUsage: vi.fn(async () => ({ periodStart: "2026-05-01", metrics: {} })),
    checkPlanLimit: vi.fn(async (_o, limitKey) => ({ limitKey, allowed: true, reason: "within_limit", planId, limit: 1, current: 0, requested: 0, remaining: 1 }) as never),
    ...overrides
  };
}

describe("tenant subscription handlers", () => {
  it("starts a subscription for an authorized tenant operator using the principal identity", async () => {
    const d = deps();
    const res = await createSubscriptionHandlers(allow, d).start(req({ planId, idempotencyKey: "key-12345678", accountId: "spoof" }), org);
    expect(res.status).toBe(201);
    expect(d.start).toHaveBeenCalledWith(org, "acct", { planId, idempotencyKey: "key-12345678" });
    expect(allow.authorizeAction).toHaveBeenCalledWith("Bearer x", "tenant.manage", { organizationId: org });
  });

  it("returns 403 without tenant.manage and never touches storage", async () => {
    const d = deps();
    const res = await createSubscriptionHandlers(deny, d).change(req({ planId, idempotencyKey: "key-12345678" }), org);
    expect(res.status).toBe(403);
    expect(d.change).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const h = createSubscriptionHandlers(allow, deps());
    expect((await h.start(req({ planId: "nope", idempotencyKey: "key-12345678" }), org)).status).toBe(400);
    expect((await h.change(req({ planId, idempotencyKey: 5 }), org)).status).toBe(400);
    expect((await h.usage(req(undefined, "https://engine.test/api?period=2026-13"), org)).status).toBe(400);
    expect((await h.cancel(req({ reason: "x".repeat(501) }), org)).status).toBe(400);
  });

  it("maps not found, conflicts and blocked downgrades", async () => {
    const h = createSubscriptionHandlers(allow, deps({
      change: vi.fn(async () => ({ outcome: "blocked", violations: [{ limitKey: "max_members", limit: 1, current: 2 }] }) as never),
      start: vi.fn(async () => { throw new DomainError("subscription_conflict"); }),
      cancelPendingDowngrade: vi.fn(async () => { throw new DomainError("subscription_not_found"); })
    }));
    expect((await h.get(req(), org)).status).toBe(404);
    const blocked = await h.change(req({ planId, idempotencyKey: "key-12345678" }), org);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "plan_change_usage_exceeds_limits", violations: [{ limitKey: "max_members" }] });
    expect((await h.start(req({ planId, idempotencyKey: "key-12345678" }), org)).status).toBe(409);
    expect((await h.cancelPendingChange(req({}), org)).status).toBe(404);
    expect((await h.get(req(), "not-a-uuid")).status).toBe(404);
  });

  it("blocks suspended tenants through the lifecycle guard", async () => {
    const d = deps();
    const guard = vi.fn(async () => { throw new DomainError("tenant_suspended"); });
    const res = await createSubscriptionHandlers(allow, d, guard).start(req({ planId, idempotencyKey: "key-12345678" }), org);
    expect(res.status).toBe(423);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("reports usage and every plan limit", async () => {
    const d = deps();
    const res = await createSubscriptionHandlers(allow, d).usage(req(undefined, "https://engine.test/api?period=2026-05"), org);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limits).toHaveLength(4);
    expect(d.aggregateUsage).toHaveBeenCalledWith(org, new Date("2026-05-01T00:00:00Z"));
  });
});

describe("platform plan and status handlers", () => {
  const platformPrincipal = { ...principal, role: "platform_operator" as const };
  const platform = { authorizeAction: vi.fn(async () => platformPrincipal) };

  it("requires platform.manage for plan creation", async () => {
    const create = vi.fn();
    const h = createPlanAdminHandlers(deny, { list: vi.fn(), create, publish: vi.fn(), retire: vi.fn() });
    expect((await h.create(req({ planKey: "x" }))).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates, lists and transitions plans", async () => {
    const plan = { id: planId, status: "draft" };
    const d = {
      list: vi.fn(async () => [plan] as never),
      create: vi.fn(async () => plan as never),
      publish: vi.fn(async () => ({ ...plan, status: "published" }) as never),
      retire: vi.fn(async () => { throw new DomainError("plan_not_found"); })
    };
    const h = createPlanAdminHandlers(platform, d);
    expect((await h.create(req({ planKey: "pro" }))).status).toBe(201);
    expect(d.create).toHaveBeenCalledWith("acct", { planKey: "pro" });
    expect((await h.list(req(undefined, "https://engine.test/api?status=bogus"))).status).toBe(400);
    expect((await h.list(req(undefined, "https://engine.test/api?status=draft"))).status).toBe(200);
    expect((await h.transition(req({}), planId, "publish")).status).toBe(200);
    expect((await h.transition(req({}), planId, "retire")).status).toBe(404);
    expect((await h.transition(req({}), "bad", "publish")).status).toBe(404);
    const invalid = createPlanAdminHandlers(platform, { ...d, create: vi.fn(async () => { throw new DomainError("invalid_plan"); }) });
    expect((await invalid.create(req({}))).status).toBe(400);
  });

  it("validates platform status overrides and maps invalid transitions to 409", async () => {
    const setStatus = vi.fn(async () => { throw new DomainError("invalid_state_subscription_transition"); });
    const post = createPlatformSubscriptionStatusHandler(platform, { setStatus });
    expect((await post(req({ status: "trialing" }), org)).status).toBe(400);
    expect((await post(req({ status: "active" }), org)).status).toBe(409);
    expect((await createPlatformSubscriptionStatusHandler(deny, { setStatus })(req({ status: "active" }), org)).status).toBe(403);
  });
});
