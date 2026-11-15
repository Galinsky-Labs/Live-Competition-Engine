import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { clientIp, createSignupHandlers, type SignupHandlerDeps } from "./handler";
import { createOnboardingHandlers, type OnboardingDeps } from "../organizations/[organizationId]/onboarding/handler";

const org = "11111111-1111-4111-8111-111111111111";
const post = (body: unknown, headers: Record<string, string> = {}) => new Request("https://engine.test/api/signup", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
});
const sessionAuth = { authorize: vi.fn(async () => ({ accountId: "acct", sessionId: "sess" })) };
const noAuth = { authorize: vi.fn(async () => { throw new AuthenticationError("missing"); }) };

function deps(overrides: Partial<SignupHandlerDeps> = {}): SignupHandlerDeps {
  return {
    signup: vi.fn(async () => ({ accountId: "a", organizationId: org, slug: "abc" }) as never),
    checkSlug: vi.fn(async () => ({ available: true, slug: "abc" })),
    verifyEmail: vi.fn(async () => ({ accountId: "a", verifiedAt: new Date(0) })),
    resend: vi.fn(async () => ({ expiresAt: new Date(0), delivered: true })),
    hashIp: vi.fn((ip: string) => `hash(${ip})`),
    ...overrides
  };
}

describe("signup handlers", () => {
  it("creates a tenant and rate-limits by the hashed client IP only", async () => {
    const d = deps();
    const res = await createSignupHandlers(noAuth, d).signup(post({ email: "a@example.org" }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    expect(res.status).toBe(201);
    expect(d.hashIp).toHaveBeenCalledWith("203.0.113.9");
    expect(d.signup).toHaveBeenCalledWith({ email: "a@example.org" }, "hash(203.0.113.9)");
  });

  it("maps conflicts, rate limits and invalid input", async () => {
    const codes: [string, number][] = [["slug_unavailable", 409], ["email_unavailable", 409], ["rate_limited", 429], ["invalid_email", 400], ["slug_reserved", 400]];
    for (const [code, status] of codes) {
      const h = createSignupHandlers(noAuth, deps({ signup: vi.fn(async () => { throw new DomainError(code); }) }));
      const res = await h.signup(post({}));
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(code);
    }
    const bad = await createSignupHandlers(noAuth, deps()).signup(new Request("https://engine.test", { method: "POST", body: "[" }));
    expect(bad.status).toBe(400);
  });

  it("checks slug availability", async () => {
    const h = createSignupHandlers(noAuth, deps());
    expect((await h.slugAvailability(new Request("https://engine.test/?slug=abc"))).status).toBe(200);
    expect((await h.slugAvailability(new Request("https://engine.test/"))).status).toBe(400);
  });

  it("verifies tokens and reports invalid ones as 400", async () => {
    const h = createSignupHandlers(noAuth, deps({ verifyEmail: vi.fn(async () => { throw new DomainError("invalid_verification_token"); }) }));
    expect((await h.verify(post({ accountId: org, token: "x" }))).status).toBe(400);
  });

  it("requires a session to resend and uses the session identity", async () => {
    const d = deps();
    expect((await createSignupHandlers(noAuth, d).resend(post({ accountId: "spoof" }))).status).toBe(401);
    expect(d.resend).not.toHaveBeenCalled();
    expect((await createSignupHandlers(sessionAuth, d).resend(post({ accountId: "spoof" }, { authorization: "Bearer x" }))).status).toBe(202);
    expect(d.resend).toHaveBeenCalledWith("acct");
    const verified = createSignupHandlers(sessionAuth, deps({ resend: vi.fn(async () => { throw new DomainError("email_already_verified"); }) }));
    expect((await verified.resend(post({}))).status).toBe(409);
  });

  it("falls back to a shared bucket without proxy headers", () => {
    expect(clientIp(new Request("https://engine.test"))).toBe("unknown");
    expect(clientIp(new Request("https://engine.test", { headers: { "x-real-ip": "198.51.100.1" } }))).toBe("198.51.100.1");
  });
});

describe("onboarding handlers", () => {
  const principal = { accountId: "acct", sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
  const allow = { authorizeAction: vi.fn(async () => principal) };
  const deny = { authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };
  const od = (overrides: Partial<OnboardingDeps> = {}): OnboardingDeps => ({
    checklist: vi.fn(async () => ({ steps: [] }) as never),
    setSkipped: vi.fn(async () => ({ steps: [] }) as never),
    createFirstEvent: vi.fn(async () => ({ competitionId: "c", created: true })),
    guard: vi.fn(async () => undefined),
    ...overrides
  });

  it("serves the checklist to tenant operators and refuses others", async () => {
    const d = od();
    expect((await createOnboardingHandlers(allow, d).get(post({}), org)).status).toBe(200);
    expect((await createOnboardingHandlers(deny, d).get(post({}), org)).status).toBe(403);
    expect((await createOnboardingHandlers(allow, d).get(post({}), "nope")).status).toBe(404);
  });

  it("creates the first event with the principal identity and maps plan limits", async () => {
    const d = od();
    expect((await createOnboardingHandlers(allow, d).firstEvent(post({ title: "Show" }), org)).status).toBe(201);
    expect(d.createFirstEvent).toHaveBeenCalledWith(org, "acct", { title: "Show" });
    const limited = od({ createFirstEvent: vi.fn(async () => { throw new DomainError("plan_limit_exceeded"); }) });
    expect((await createOnboardingHandlers(allow, limited).firstEvent(post({ title: "Show" }), org)).status).toBe(402);
    const invalid = od({ createFirstEvent: vi.fn(async () => { throw new DomainError("invalid_event_title"); }) });
    expect((await createOnboardingHandlers(allow, invalid).firstEvent(post({ title: "" }), org)).status).toBe(400);
  });

  it("validates skip requests and enforces the lifecycle guard", async () => {
    expect((await createOnboardingHandlers(allow, od()).skip(post({ step: 1 }), org)).status).toBe(400);
    const suspended = od({ guard: vi.fn(async () => { throw new DomainError("tenant_suspended"); }) });
    expect((await createOnboardingHandlers(allow, suspended).skip(post({ step: "branding_set", skipped: true }), org)).status).toBe(423);
    expect(suspended.setSkipped).not.toHaveBeenCalled();
  });
});
