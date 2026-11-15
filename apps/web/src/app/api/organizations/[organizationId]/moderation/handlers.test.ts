import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { clientKeyFromRequest, createModerationHandlers, type ModerationService } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const operator = { authorize: vi.fn(async () => ({ accountId, sessionId: "s", organizationId: org })), authorizeAction: vi.fn(async () => ({ accountId, sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const })) };
const memberOnly = { authorize: vi.fn(async () => ({ accountId, sessionId: "s", organizationId: org })), authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };

function service(overrides: Partial<ModerationService> = {}): ModerationService {
  const none = vi.fn(async () => undefined);
  return {
    submitReport: vi.fn(async () => ({ report: { id, status: "open" }, duplicate: false })),
    listReports: vi.fn(async () => []), getReport: vi.fn(async () => null), transitionReport: vi.fn(async () => ({})),
    addEvidence: vi.fn(async () => ({ id })), deleteReport: none, takeModerationAction: vi.fn(async () => ({ id })),
    reverseModerationAction: none, listActions: vi.fn(async () => []), listActionsAffecting: vi.fn(async () => []),
    fileAppeal: vi.fn(async () => ({ id, status: "open" })), decideAppeal: vi.fn(async () => ({})), listAppeals: vi.fn(async () => []),
    placeLegalHold: vi.fn(async () => ({ id })), releaseLegalHold: none,
    ...overrides
  };
}

const req = (method: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer t" }) =>
  new Request("https://engine.test/api/x", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("moderation handlers", () => {
  it("accepts anonymous reports keyed by client address", async () => {
    const svc = service();
    const response = await createModerationHandlers(operator, svc).submitReport(
      req("POST", { subjectType: "page", subjectId: "p1", reason: "spam" }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), org);
    expect(response.status).toBe(201);
    expect(svc.submitReport).toHaveBeenCalledWith(org, { anonymousKey: "203.0.113.9" }, expect.any(Object));
  });

  it("uses the session identity for member reports and maps rate limits to 429", async () => {
    const svc = service({ submitReport: vi.fn(async () => { throw new DomainError("rate_limited"); }) });
    const response = await createModerationHandlers(memberOnly, svc).submitReport(req("POST", { subjectType: "page", subjectId: "p", reason: "spam", accountId: "spoof" }), org);
    expect(response.status).toBe(429);
    expect(svc.submitReport).toHaveBeenCalledWith(org, { accountId }, expect.any(Object));
  });

  it("keeps the queue and decisions behind tenant.manage", async () => {
    const svc = service();
    const handlers = createModerationHandlers(memberOnly, svc);
    expect((await handlers.listReports(req("GET"), org)).status).toBe(403);
    expect((await handlers.takeAction(req("POST", { subjectType: "page", subjectId: "p", action: "hide", reason: "x" }), org)).status).toBe(403);
    expect((await handlers.decideAppeal(req("POST", { decision: "upheld" }), org, id)).status).toBe(403);
    expect(svc.takeModerationAction).not.toHaveBeenCalled();
  });

  it("lets the affected member appeal with their own identity", async () => {
    const svc = service();
    const response = await createModerationHandlers(memberOnly, svc).fileAppeal(req("POST", { statement: "context" }), org, id);
    expect(response.status).toBe(201);
    expect(svc.fileAppeal).toHaveBeenCalledWith(org, accountId, id, "context");
  });

  it("maps invalid input, missing reports, illegal transitions and legal holds", async () => {
    const handlers = createModerationHandlers(operator, service({
      takeModerationAction: vi.fn(async () => { throw new DomainError("invalid_subject_type"); }),
      transitionReport: vi.fn(async () => { throw new DomainError("invalid_state_report_transition"); }),
      deleteReport: vi.fn(async () => { throw new DomainError("legal_hold_active"); })
    }));
    expect((await handlers.takeAction(req("POST", { subjectType: "db" }), org)).status).toBe(400);
    expect((await handlers.getReport(req("GET"), org, id)).status).toBe(404);
    expect((await handlers.transitionReport(req("POST", { to: "open", expectedRevision: 1 }), org, id)).status).toBe(409);
    expect((await handlers.deleteReport(req("DELETE"), org, id)).status).toBe(409);
    expect((await handlers.submitReport(req("POST", "x", {}), "not-a-uuid")).status).toBe(404);
  });

  it("bounds the client key", () => {
    expect(clientKeyFromRequest(new Request("https://x", { headers: { "x-forwarded-for": "a".repeat(500) } })).length).toBe(100);
    expect(clientKeyFromRequest(new Request("https://x"))).toBe("unknown");
  });
});
