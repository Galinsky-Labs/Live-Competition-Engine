import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createFeatureControlHandlers, type FeatureControlService } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const principal = { accountId: "33333333-3333-4333-8333-333333333333", sessionId: "s", role: "platform_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
const allowed = { authorize: vi.fn(), authorizeAction: vi.fn(async () => principal) };
const forbidden = { authorize: vi.fn(), authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };

function service(overrides: Partial<FeatureControlService> = {}): FeatureControlService {
  return {
    setPlatformFeature: vi.fn(async () => ({ revision: 2 })),
    setTenantScopedFeature: vi.fn(async () => ({ revision: 1 })),
    setTenantCeiling: vi.fn(async () => ({ revision: 1, tenantFlagRevision: 1 })),
    effectiveTenantFeatures: vi.fn(async () => []),
    listPlatformFeatures: vi.fn(async () => []),
    listTenantOverrides: vi.fn(async () => []),
    listFeatureAudit: vi.fn(async () => []),
    ...overrides
  };
}

const req = (method: string, body?: unknown, url = "https://engine.test/api/platform/features") => new Request(url, {
  method, headers: { authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body)
});

describe("feature control handlers", () => {
  it("requires platform.manage with no tenant scope for platform writes", async () => {
    const svc = service();
    const response = await createFeatureControlHandlers(allowed, svc).platformSet(req("POST", { feature: "chat", enabled: true, expectedRevision: 1 }));
    expect(response.status).toBe(200);
    expect(allowed.authorizeAction).toHaveBeenCalledWith("Bearer t", "platform.manage", {});
    expect(svc.setPlatformFeature).toHaveBeenCalledWith(principal.accountId, { feature: "chat", enabled: true, expectedRevision: 1 });
  });

  it("refuses tenant operators on platform endpoints", async () => {
    const svc = service();
    const handlers = createFeatureControlHandlers(forbidden, svc);
    expect((await handlers.platformCeiling(req("PUT", { organizationId: org, feature: "chat", locked: true, expectedRevision: 0 }))).status).toBe(403);
    expect((await handlers.tenantSet(req("PUT", { scope: "tenant" }), org)).status).toBe(403);
    expect(svc.setTenantCeiling).not.toHaveBeenCalled();
  });

  it("maps a platform lock to 403 and stale revisions to 409", async () => {
    const handlers = createFeatureControlHandlers(allowed, service({
      setTenantScopedFeature: vi.fn(async () => { throw new DomainError("feature_locked_by_platform"); }),
      setTenantCeiling: vi.fn(async () => { throw new DomainError("revision_conflict"); })
    }));
    expect((await handlers.tenantSet(req("PUT", { scope: "tenant", feature: "chat", enabled: true, expectedRevision: 0 }), org)).status).toBe(403);
    expect((await handlers.platformCeiling(req("PUT", { organizationId: org, feature: "chat", locked: true, expectedRevision: 5 }))).status).toBe(409);
  });

  it("rejects invalid input and unknown tenants", async () => {
    const handlers = createFeatureControlHandlers(allowed, service({
      setPlatformFeature: vi.fn(async () => { throw new DomainError("invalid_feature"); }),
      setTenantCeiling: vi.fn(async () => { throw new DomainError("organization_not_found"); })
    }));
    expect((await handlers.platformSet(req("POST", { feature: "nope", enabled: true, expectedRevision: 0 }))).status).toBe(400);
    expect((await handlers.platformSet(new Request("https://x", { method: "POST", headers: { authorization: "Bearer t" }, body: "{" }))).status).toBe(400);
    expect((await handlers.platformCeiling(req("PUT", { organizationId: org, feature: "chat", locked: true, expectedRevision: 0 }))).status).toBe(404);
    expect((await handlers.tenantEffective(req("GET"), "bad")).status).toBe(404);
  });

  it("lists effective tenant flags under tenant.manage", async () => {
    const response = await createFeatureControlHandlers(allowed, service()).tenantEffective(req("GET"), org);
    expect(response.status).toBe(200);
    expect(allowed.authorizeAction).toHaveBeenLastCalledWith("Bearer t", "tenant.manage", { organizationId: org });
  });
});
