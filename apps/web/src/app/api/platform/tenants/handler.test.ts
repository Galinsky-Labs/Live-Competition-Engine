import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createPlatformAdminHandlers, type PlatformAdminDeps } from "./handler";

const org = "11111111-1111-4111-8111-111111111111";
const flagId = "33333333-3333-4333-8333-333333333333";
const principal = { accountId: "op", sessionId: "sess", role: "platform_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
const allow = { authorize: vi.fn(async () => ({ accountId: "member", sessionId: "s2", organizationId: org })), authorizeAction: vi.fn(async () => principal) };
const deny = {
  authorize: vi.fn(async () => { throw new AuthenticationError("forbidden"); }),
  authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); })
};
const req = (body?: unknown, headers: Record<string, string> = {}, url = "https://engine.test/api") => new Request(url, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: "Bearer x", "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

function deps(overrides: Partial<PlatformAdminDeps> = {}): PlatformAdminDeps {
  const fn = () => vi.fn(async () => ({}) as never);
  return {
    stepUpWithRecoveryCode: vi.fn(async () => ({ id: "g", token: "t".repeat(43), method: "recovery_code" as const, expiresAt: new Date(0) })),
    stepUpWithFreshSession: fn(), revokeStepUp: vi.fn(async () => 1), listTenants: vi.fn(async () => []),
    getTenantDetail: vi.fn(async () => null), changeTenantLifecycle: fn(), addSupportNote: fn(),
    listSupportNotes: vi.fn(async () => []), raiseFraudFlag: fn(), resolveFraudFlag: fn(), listFraudFlags: vi.fn(async () => []),
    createAnnouncement: fn(), addAnnouncementVersion: fn(), publishAnnouncementVersion: fn(), withdrawAnnouncement: vi.fn(async () => undefined),
    listAnnouncements: vi.fn(async () => []), listTenantAnnouncements: vi.fn(async () => []),
    platformAudit: vi.fn(async () => ({ events: [], verification: { valid: true } }) as never),
    ...overrides
  };
}

describe("platform admin handlers", () => {
  it("refuses every operation without platform.manage", async () => {
    const d = deps();
    const h = createPlatformAdminHandlers(deny, d);
    const responses = await Promise.all([
      h.stepUp(req({ method: "recovery_code", recoveryCode: "x" })), h.listTenants(req()), h.getTenant(req(), org),
      h.lifecycle(req({ action: "suspend" }), org), h.addNote(req({ body: "x" }), org), h.raiseFlag(req({})),
      h.resolveFlag(req({}), flagId), h.createAnnouncement(req({})), h.publishAnnouncement(req({ version: 1 }), org),
      h.withdrawAnnouncement(req({}), org), h.audit(req())
    ]);
    expect(responses.map(r => r.status)).toEqual(Array(responses.length).fill(403));
    expect(d.changeTenantLifecycle).not.toHaveBeenCalled();
    expect(d.stepUpWithRecoveryCode).not.toHaveBeenCalled();
  });

  it("issues step-up grants for the calling session and rejects unknown methods", async () => {
    const d = deps();
    const h = createPlatformAdminHandlers(allow, d);
    const res = await h.stepUp(req({ method: "recovery_code", recoveryCode: "code" }));
    expect(res.status).toBe(201);
    expect(d.stepUpWithRecoveryCode).toHaveBeenCalledWith({ accountId: "op", sessionId: "sess" }, "code");
    expect((await h.stepUp(req({ method: "password" }))).status).toBe(400);
    const failing = createPlatformAdminHandlers(allow, deps({ stepUpWithRecoveryCode: vi.fn(async () => { throw new DomainError("step_up_failed"); }) }));
    expect((await failing.stepUp(req({ method: "recovery_code", recoveryCode: "bad" }))).status).toBe(403);
  });

  it("passes the step-up header to lifecycle changes and maps failures", async () => {
    const d = deps();
    const h = createPlatformAdminHandlers(allow, d);
    await h.lifecycle(req({ action: "suspend", reason: "abuse", expectedRevision: 0 }, { "x-step-up-token": "tok" }), org);
    expect(d.changeTenantLifecycle).toHaveBeenCalledWith({ accountId: "op", sessionId: "sess" }, org,
      { action: "suspend", reason: "abuse", expectedRevision: 0 }, "tok");
    const mapping: [string, number][] = [["step_up_required", 403], ["tenant_not_found", 404], ["tenant_revision_conflict", 409],
      ["invalid_state_tenant_transition", 409], ["invalid_reason", 400]];
    for (const [code, status] of mapping) {
      const failing = createPlatformAdminHandlers(allow, deps({ changeTenantLifecycle: vi.fn(async () => { throw new DomainError(code); }) }));
      expect((await failing.lifecycle(req({ action: "suspend" }), org)).status).toBe(status);
    }
  });

  it("validates list queries and returns 404 for unknown tenants", async () => {
    const h = createPlatformAdminHandlers(allow, deps());
    expect((await h.listTenants(req(undefined, {}, "https://engine.test/api?status=gone"))).status).toBe(400);
    expect((await h.listTenants(req(undefined, {}, "https://engine.test/api?limit=0"))).status).toBe(400);
    expect((await h.listTenants(req(undefined, {}, "https://engine.test/api?status=suspended&limit=10"))).status).toBe(200);
    expect((await h.getTenant(req(), org)).status).toBe(404);
    expect((await h.getTenant(req(), "bad")).status).toBe(404);
    expect((await h.listFlags(req(undefined, {}, "https://engine.test/api?organizationId=bad"))).status).toBe(400);
    expect((await h.audit(req(undefined, {}, "https://engine.test/api?limit=abc"))).status).toBe(400);
  });

  it("maps flag, note and announcement errors", async () => {
    const h = createPlatformAdminHandlers(allow, deps({
      raiseFraudFlag: vi.fn(async () => { throw new DomainError("flag_subject_not_found"); }),
      resolveFraudFlag: vi.fn(async () => { throw new DomainError("flag_revision_conflict"); }),
      addSupportNote: vi.fn(async () => { throw new DomainError("invalid_note"); }),
      publishAnnouncementVersion: vi.fn(async () => { throw new DomainError("announcement_not_found"); })
    }));
    expect((await h.raiseFlag(req({ subjectType: "account" }))).status).toBe(404);
    expect((await h.resolveFlag(req({ resolution: "ok", expectedRevision: 1 }), flagId)).status).toBe(409);
    expect((await h.addNote(req({ body: "" }), org)).status).toBe(400);
    expect((await h.publishAnnouncement(req({ version: 1 }), org)).status).toBe(404);
  });

  it("lets tenant members read announcements and refuses non-members", async () => {
    const d = deps();
    expect((await createPlatformAdminHandlers(allow, d).tenantAnnouncements(req(), org)).status).toBe(200);
    expect(d.listTenantAnnouncements).toHaveBeenCalledWith(org);
    expect((await createPlatformAdminHandlers(deny, d).tenantAnnouncements(req(), org)).status).toBe(403);
    expect((await createPlatformAdminHandlers(allow, d).tenantAnnouncements(req(), "bad")).status).toBe(404);
  });
});
