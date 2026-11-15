import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createTenantAdminHandlers, type TenantAdminService } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const account = "22222222-2222-4222-8222-222222222222";
const principal = { accountId: "33333333-3333-4333-8333-333333333333", sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };

const allowed = { authorize: vi.fn(async () => ({ accountId: principal.accountId, sessionId: "s" })), authorizeAction: vi.fn(async () => principal) };
const denied = {
  authorize: vi.fn(async () => { throw new AuthenticationError("missing"); }),
  authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); })
};

function service(overrides: Partial<TenantAdminService> = {}): TenantAdminService {
  const fail = async () => { throw new Error("unexpected call"); };
  return {
    listMembers: vi.fn(async () => []), setMembershipStatus: vi.fn(async () => undefined), grantTenantRole: vi.fn(async () => ({ id: "g1" })),
    revokeTenantRole: vi.fn(async () => undefined), createInvitation: vi.fn(fail), revokeInvitation: vi.fn(async () => undefined),
    listInvitations: vi.fn(async () => []), acceptInvitation: vi.fn(fail), listVenues: vi.fn(async () => []),
    createVenue: vi.fn(fail), updateVenue: vi.fn(fail), archiveVenue: vi.fn(async () => undefined),
    assignCompetitionVenue: vi.fn(async () => undefined),
    showOverview: vi.fn(async () => ({ statusCounts: { draft: 1 }, competitions: [] })),
    billingSection: vi.fn(async () => ({ status: "not_configured" as const })),
    moderationSection: vi.fn(async () => ({ status: "not_configured" as const })),
    ...overrides
  };
}

const req = (method: string, body?: unknown) => new Request("https://engine.test/api/x", {
  method, headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body)
});

describe("tenant administration handlers", () => {
  it("lists members for tenant managers", async () => {
    const svc = service();
    const response = await createTenantAdminHandlers(allowed, svc).listMembers(req("GET"), org);
    expect(response.status).toBe(200);
    expect(allowed.authorizeAction).toHaveBeenCalledWith("Bearer t", "tenant.manage", { organizationId: org });
  });

  it("rejects non-managers before touching the service", async () => {
    const svc = service();
    const handlers = createTenantAdminHandlers(denied, svc);
    expect((await handlers.grantRole(req("POST", { role: "viewer" }), org, account)).status).toBe(403);
    expect((await handlers.overview(req("GET"), org)).status).toBe(403);
    expect(svc.grantTenantRole).not.toHaveBeenCalled();
  });

  it("returns 404 for malformed tenant ids", async () => {
    expect((await createTenantAdminHandlers(allowed, service()).listVenues(req("GET"), "not-a-uuid")).status).toBe(404);
  });

  it("maps domain errors: non-grantable roles 400, conflicts 409, missing members 404", async () => {
    const handlers = createTenantAdminHandlers(allowed, service({
      grantTenantRole: vi.fn(async () => { throw new DomainError("role_not_grantable"); }),
      setMembershipStatus: vi.fn(async () => { throw new DomainError("member_not_found"); }),
      updateVenue: vi.fn(async () => { throw new DomainError("venue_revision_conflict"); })
    }));
    expect((await handlers.grantRole(req("POST", { role: "platform_operator" }), org, account)).status).toBe(400);
    expect((await handlers.setMemberStatus(req("POST", { status: "suspended" }), org, account)).status).toBe(404);
    expect((await handlers.updateVenue(req("PUT", { name: "x", expectedRevision: 1 }), org, account)).status).toBe(409);
  });

  it("validates membership status input", async () => {
    const response = await createTenantAdminHandlers(allowed, service()).setMemberStatus(req("POST", { status: "deleted" }), org, account);
    expect(response.status).toBe(400);
  });

  it("accepts an invitation as the authenticated account, not a body-supplied identity", async () => {
    const accept = vi.fn(async () => ({ membershipCreated: true, roleGrantId: null }));
    const response = await createTenantAdminHandlers(allowed, service({ acceptInvitation: accept }))
      .acceptInvitation(req("POST", { token: "x".repeat(43), accountId: account }), org);
    expect(response.status).toBe(200);
    expect(accept).toHaveBeenCalledWith(org, principal.accountId, "x".repeat(43));
    expect((await createTenantAdminHandlers(denied, service()).acceptInvitation(req("POST", { token: "x" }), org)).status).toBe(401);
  });

  it("maps expired invitations to 410", async () => {
    const handlers = createTenantAdminHandlers(allowed, service({ acceptInvitation: vi.fn(async () => { throw new DomainError("invitation_expired"); }) }));
    expect((await handlers.acceptInvitation(req("POST", { token: "x" }), org)).status).toBe(410);
  });

  it("returns overview with not-configured optional sections", async () => {
    const response = await createTenantAdminHandlers(allowed, service()).overview(req("GET"), org);
    const body = await response.json();
    expect(body.billing).toEqual({ status: "not_configured" });
    expect(body.shows.statusCounts.draft).toBe(1);
  });
});
