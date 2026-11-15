import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createJudgeHandlers, type JudgesService } from "./handlers";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const accountId = "44444444-4444-4444-8444-444444444444";
const judgeId = "55555555-5555-4555-8555-555555555555";
const comp = { organizationId, competitionId };

const authorizer = (role: "event_producer" | "judge" | null) => ({
  authorize: vi.fn(async () => ({ accountId, sessionId: "s", organizationId })),
  authorizeAction: vi.fn(async (_h: string | null, action: string) => {
    const allowed = role === "event_producer" ? ["event.manage"] : role === "judge" ? ["judging.score"] : [];
    if (!allowed.includes(action)) throw new AuthenticationError("forbidden");
    return { accountId, sessionId: "s", role: role!, roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});
const req = (method: string, body?: unknown, url = "https://engine.test/api") =>
  new Request(url, { method, headers: { authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body) });
const svc = (overrides: Partial<JudgesService> = {}) => new Proxy(overrides, {
  get: (target, key) => (target as Record<string, unknown>)[key as string] ?? vi.fn(async () => { throw new Error(`unexpected ${String(key)}`); })
}) as JudgesService;

describe("judge handlers", () => {
  it("lets producers invite (201) and returns the one-time token", async () => {
    const inviteJudge = vi.fn(async () => ({ invitation: { id: "i" }, token: "tok" }));
    const res = await createJudgeHandlers(authorizer("event_producer"), svc({ inviteJudge: inviteJudge as never }))
      .invite(req("POST", { email: "j@example.com", displayName: "J" }), comp);
    expect(res.status).toBe(201);
    expect((await res.json()).token).toBe("tok");
    expect(inviteJudge).toHaveBeenCalledWith(organizationId, competitionId, accountId, { email: "j@example.com", displayName: "J", expiresInHours: undefined });
  });

  it("keeps producer and judge surfaces apart", async () => {
    const asJudge = createJudgeHandlers(authorizer("judge"), svc({ listJudgeAssignments: vi.fn(async () => ({ rounds: [] })) as never }));
    expect((await asJudge.invite(req("POST", { email: "x@y.zz", displayName: "x" }), comp)).status).toBe(403);
    expect((await asJudge.assignments(req("GET"), comp)).status).toBe(200);
    const asProducer = createJudgeHandlers(authorizer("event_producer"), svc());
    expect((await asProducer.assignments(req("GET"), comp)).status).toBe(403);
    expect((await asProducer.declareConflict(req("POST", { entryId: judgeId, reason: "x" }), comp)).status).toBe(403);
  });

  it("lets any member attempt acceptance; the service decides", async () => {
    const acceptInvitation = vi.fn(async () => { throw new DomainError("invitation_email_mismatch"); });
    const h = createJudgeHandlers(authorizer(null), svc({ acceptInvitation }));
    expect((await h.accept(req("POST", { token: "x".repeat(43) }), comp)).status).toBe(403);
    const expired = createJudgeHandlers(authorizer(null), svc({ acceptInvitation: vi.fn(async () => { throw new DomainError("invitation_expired"); }) }));
    expect((await expired.accept(req("POST", { token: "x".repeat(43) }), comp)).status).toBe(410);
    const used = createJudgeHandlers(authorizer(null), svc({ acceptInvitation: vi.fn(async () => { throw new DomainError("invitation_used_conflict"); }) }));
    expect((await used.accept(req("POST", { token: "x".repeat(43) }), comp)).status).toBe(409);
  });

  it("validates ids, bodies and query parameters", async () => {
    const h = createJudgeHandlers(authorizer("event_producer"), svc({ listRecusals: vi.fn(async () => []) }));
    expect((await h.updateStatus(req("POST", {}), { ...comp, judgeId: "bad" })).status).toBe(404);
    expect((await h.recuse(new Request("https://engine.test", { method: "POST", headers: { authorization: "Bearer t" }, body: "nope" }), comp)).status).toBe(400);
    expect((await h.listRecusals(req("GET", undefined, "https://engine.test/api?judgeId=bad"), comp)).status).toBe(400);
    expect((await h.listRecusals(req("GET", undefined, `https://engine.test/api?judgeId=${judgeId}`), comp)).status).toBe(200);
  });

  it("maps lifecycle conflicts and missing judges", async () => {
    const h = createJudgeHandlers(authorizer("event_producer"), svc({
      updateJudgeStatus: vi.fn(async () => { throw new DomainError("judge_revision_conflict"); }),
      rescindRecusal: vi.fn(async () => { throw new DomainError("recusal_not_found"); })
    }));
    expect((await h.updateStatus(req("POST", { status: "verified", expectedRevision: 1 }), { ...comp, judgeId })).status).toBe(409);
    expect((await h.rescind(req("POST", { reason: "x" }), { ...comp, recusalId: judgeId })).status).toBe(404);
  });
});
