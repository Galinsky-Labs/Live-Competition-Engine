import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createCritiqueHandlers, createPublicCritiquesHandler, type CritiquesService } from "./handlers";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const critiqueId = "77777777-7777-4777-8777-777777777777";
const accountId = "44444444-4444-4444-8444-444444444444";
const comp = { organizationId, competitionId };

const as = (role: "event_producer" | "judge" | "member") => ({
  authorize: vi.fn(async () => ({ accountId, sessionId: "s", organizationId })),
  authorizeAction: vi.fn(async (_h: string | null, action: string) => {
    const ok = (role === "judge" && action === "judging.score") || (role === "event_producer" && action === "event.manage");
    if (!ok) throw new AuthenticationError("forbidden");
    return { accountId, sessionId: "s", role: role as "judge", roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});
const req = (method: string, body?: unknown, url = "https://engine.test/api") =>
  new Request(url, { method, headers: { authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body) });
const svc = (overrides: Partial<CritiquesService> = {}) => new Proxy(overrides, {
  get: (target, key) => (target as Record<string, unknown>)[key as string] ?? vi.fn(async () => { throw new Error(`unexpected ${String(key)}`); })
}) as CritiquesService;

describe("critique handlers", () => {
  it("judges save drafts; producers and plain members cannot", async () => {
    const saveCritiqueDraft = vi.fn(async () => ({ id: critiqueId }));
    const params = { ...comp, roundId: critiqueId, performanceId: critiqueId };
    const body = { body: "Good", visibility: "private" };
    expect((await createCritiqueHandlers(as("judge"), svc({ saveCritiqueDraft: saveCritiqueDraft as never })).saveDraft(req("PUT", body), params)).status).toBe(200);
    expect(saveCritiqueDraft).toHaveBeenCalledWith(organizationId, competitionId, accountId, critiqueId, critiqueId, { ...body, expectedRevision: undefined });
    expect((await createCritiqueHandlers(as("event_producer"), svc()).saveDraft(req("PUT", body), params)).status).toBe(403);
    expect((await createCritiqueHandlers(as("member"), svc()).saveDraft(req("PUT", body), params)).status).toBe(403);
  });

  it("only producers moderate and resolve appeals", async () => {
    const judge = createCritiqueHandlers(as("judge"), svc());
    expect((await judge.moderate(req("POST", { decision: "published", expectedRevision: 1 }), { ...comp, critiqueId })).status).toBe(403);
    expect((await judge.resolveAppeal(req("POST", { status: "upheld" }), { ...comp, appealId: critiqueId })).status).toBe(403);
    const producer = createCritiqueHandlers(as("event_producer"), svc({ moderateCritique: vi.fn(async () => { throw new DomainError("self_approval_forbidden"); }) }));
    expect((await producer.moderate(req("POST", { decision: "published", expectedRevision: 1 }), { ...comp, critiqueId })).status).toBe(403);
  });

  it("entrants read their own critiques and file appeals as members", async () => {
    const fileAppeal = vi.fn(async () => ({ id: "a" }));
    const h = createCritiqueHandlers(as("member"), svc({ fileAppeal: fileAppeal as never, listEntrantCritiques: vi.fn(async () => []) }));
    expect((await h.mine(req("GET"), comp)).status).toBe(200);
    expect((await h.fileAppeal(req("POST", { kind: "appeal", body: "Unfair" }), { ...comp, critiqueId })).status).toBe(201);
    expect(fileAppeal).toHaveBeenCalledWith(organizationId, competitionId, accountId, critiqueId, { kind: "appeal", body: "Unfair" });
  });

  it("maps conflicts, missing records, disabled feature and bad input", async () => {
    const fail = (code: string) => vi.fn(async () => { throw new DomainError(code); });
    const status = async (code: string) => (await createCritiqueHandlers(as("judge"), svc({ submitCritique: fail(code) }))
      .submit(req("POST", { expectedRevision: 1 }), { ...comp, critiqueId })).status;
    expect(await status("critique_revision_conflict")).toBe(409);
    expect(await status("critique_not_found")).toBe(404);
    expect(await status("feature_disabled")).toBe(403);
    expect(await status("judge_recused")).toBe(403);
    expect(await status("invalid_state_transition")).toBe(409);
    const h = createCritiqueHandlers(as("judge"), svc());
    expect((await h.submit(req("POST", { expectedRevision: 1 }), { ...comp, critiqueId: "x" })).status).toBe(404);
    expect((await h.submit(new Request("https://engine.test", { method: "POST", headers: { authorization: "Bearer t" }, body: "[" }), { ...comp, critiqueId })).status).toBe(400);
  });
});

describe("public critiques", () => {
  it("serves the public projection without authentication and hides disabled features", async () => {
    const ok = createPublicCritiquesHandler({ listPublicCritiques: vi.fn(async () => [{ id: "c" }]) as never });
    const res = await ok(new Request("https://engine.test"), comp);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    const off = createPublicCritiquesHandler({ listPublicCritiques: vi.fn(async () => { throw new DomainError("feature_disabled"); }) });
    expect((await off(new Request("https://engine.test"), comp)).status).toBe(404);
    expect((await ok(new Request("https://engine.test"), { ...comp, competitionId: "bad" })).status).toBe(404);
  });
});
