import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createUnsubscribeHandlers } from "../../../public/organizations/[organizationId]/unsubscribe/handler";
import { createWhiteLabelEmailHandlers, type WhiteLabelEmailService } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const principal = { accountId: "33333333-3333-4333-8333-333333333333", sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
const operator = { authorize: vi.fn(), authorizeAction: vi.fn(async () => principal) };
const member = { authorize: vi.fn(), authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };

function service(overrides: Partial<WhiteLabelEmailService> = {}): WhiteLabelEmailService {
  return {
    listSenderIdentities: vi.fn(async () => []), createSenderIdentity: vi.fn(async () => ({ id })),
    checkSenderIdentityDns: vi.fn(async () => ({ dkim: "verified", returnPath: "verified", status: "verified" })),
    setDefaultSender: vi.fn(async () => undefined), listTemplates: vi.fn(async () => []), createTemplate: vi.fn(async () => ({ id })),
    addTemplateVersion: vi.fn(async () => ({ version: 1, active: true })), activateTemplateVersion: vi.fn(async () => undefined),
    previewTemplate: vi.fn(async () => ({ subject: "s", text: "t", html: "h" })), deliverabilitySummary: vi.fn(async () => ({})),
    getEmailTrace: vi.fn(async () => null),
    ...overrides
  };
}

const req = (method: string, body?: unknown) => new Request("https://engine.test/api/x", {
  method, headers: { authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body)
});

describe("white-label email handlers", () => {
  it("lets tenant managers create senders and run the DNS check", async () => {
    const svc = service();
    const handlers = createWhiteLabelEmailHandlers(operator, svc);
    expect((await handlers.createSender(req("POST", { domainId: id, localPart: "news" }), org)).status).toBe(201);
    expect((await handlers.verifySender(req("POST"), org, id)).status).toBe(200);
    expect(svc.checkSenderIdentityDns).toHaveBeenCalledWith(org, principal.accountId, id);
  });

  it("refuses non-managers", async () => {
    const svc = service();
    expect((await createWhiteLabelEmailHandlers(member, svc).addVersion(req("POST", { subject: "x" }), org, id)).status).toBe(403);
    expect(svc.addTemplateVersion).not.toHaveBeenCalled();
  });

  it("maps whitelist violations, unverified domains and missing traces", async () => {
    const handlers = createWhiteLabelEmailHandlers(operator, service({
      addTemplateVersion: vi.fn(async () => { throw new DomainError("template_variable_not_allowed"); }),
      createSenderIdentity: vi.fn(async () => { throw new DomainError("invalid_state_domain_unverified"); }),
      setDefaultSender: vi.fn(async () => { throw new DomainError("sender_not_found"); })
    }));
    expect((await handlers.addVersion(req("POST", { subject: "{{x}}" }), org, id)).status).toBe(400);
    expect((await handlers.createSender(req("POST", {}), org)).status).toBe(409);
    expect((await handlers.defaultSender(req("POST"), org, id)).status).toBe(404);
    expect((await handlers.trace(req("GET"), org, id)).status).toBe(404);
  });
});

describe("unsubscribe endpoint", () => {
  it("GET only confirms; it never applies the unsubscribe", async () => {
    const apply = vi.fn(async () => ({ ok: true }));
    const handlers = createUnsubscribeHandlers(async () => ({ scope: "results" }), apply);
    const response = await handlers.get(new Request(`https://x/u?token=abc"><script>`), org);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<form method=\"post\">");
    expect(html).not.toContain("<script>");
    expect(apply).not.toHaveBeenCalled();
  });

  it("applies RFC 8058 one-click POSTs and rejects invalid tokens", async () => {
    const apply = vi.fn(async (_org: string, token: unknown) => ({ ok: token === "good" }));
    const handlers = createUnsubscribeHandlers(async () => null, apply);
    const oneClick = await handlers.post(new Request("https://x/u?token=good", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click"
    }), org);
    expect(oneClick.status).toBe(200);
    expect(apply).toHaveBeenCalledWith(org, "good");
    expect((await handlers.post(new Request("https://x/u?token=bad", { method: "POST" }), org)).status).toBe(404);
    expect((await handlers.get(new Request("https://x/u?token=bad"), org)).status).toBe(404);
  });
});
