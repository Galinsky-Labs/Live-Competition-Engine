import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createScoringHandlers, type ScoringService } from "./handlers";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const roundId = "33333333-3333-4333-8333-333333333333";
const performanceId = "66666666-6666-4666-8666-666666666666";
const accountId = "44444444-4444-4444-8444-444444444444";
const perf = { organizationId, competitionId, roundId, performanceId };
const comp = { organizationId, competitionId };

const as = (role: "event_producer" | "judge") => ({
  authorize: vi.fn(async () => ({ accountId, sessionId: "s" })),
  authorizeAction: vi.fn(async (_h: string | null, action: string, scope: unknown) => {
    expect(scope).toEqual(comp);
    if ((role === "judge") !== (action === "judging.score")) throw new AuthenticationError("forbidden");
    return { accountId, sessionId: "s", role, roleGrantId: "g", roleGrantVersion: 1 as const };
  })
});
const req = (method: string, body?: unknown, url = "https://engine.test/api") =>
  new Request(url, { method, headers: { authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body) });
const svc = (overrides: Partial<ScoringService> = {}) => new Proxy(overrides, {
  get: (target, key) => (target as Record<string, unknown>)[key as string] ?? vi.fn(async () => { throw new Error(`unexpected ${String(key)}`); })
}) as ScoringService;

describe("scoring handlers", () => {
  it("lets a judge save a sheet with identity from the session", async () => {
    const saveScoreSheet = vi.fn(async () => ({ sheet: { id: "x" }, changed: true }));
    const res = await createScoringHandlers(as("judge"), svc({ saveScoreSheet: saveScoreSheet as never }))
      .saveSheet(req("PUT", { values: { craft: 5 }, submit: true, judgeId: "spoof" }), perf);
    expect(res.status).toBe(200);
    expect(saveScoreSheet).toHaveBeenCalledWith(organizationId, competitionId, accountId, roundId, performanceId,
      { values: { craft: 5 }, submit: true, expectedRevision: undefined });
  });

  it("separates judge and producer capabilities", async () => {
    const judge = createScoringHandlers(as("judge"), svc());
    expect((await judge.standings(req("GET"), comp)).status).toBe(403);
    expect((await judge.decideCorrection(req("POST", { decision: "approved" }), { ...comp, correctionId: performanceId })).status).toBe(403);
    const producer = createScoringHandlers(as("event_producer"), svc());
    expect((await producer.saveSheet(req("PUT", { values: {}, submit: false }), perf)).status).toBe(403);
  });

  it("maps scoring failures", async () => {
    const fail = (code: string) => vi.fn(async () => { throw new DomainError(code); });
    const status = async (code: string) => (await createScoringHandlers(as("judge"), svc({ saveScoreSheet: fail(code) }))
      .saveSheet(req("PUT", { values: {}, submit: true }), perf)).status;
    expect(await status("score_immutable_conflict")).toBe(409);
    expect(await status("score_revision_conflict")).toBe(409);
    expect(await status("judge_recused")).toBe(403);
    expect(await status("judge_not_verified")).toBe(403);
    expect(await status("performance_not_found")).toBe(404);
    expect(await status("invalid_score_values")).toBe(400);
    const producer = createScoringHandlers(as("event_producer"), svc({ decideCorrection: fail("self_approval_forbidden") }));
    expect((await producer.decideCorrection(req("POST", { decision: "approved", expectedRevision: 1 }), { ...comp, correctionId: performanceId })).status).toBe(403);
  });

  it("validates path ids and query parameters", async () => {
    const getStandings = vi.fn(async () => ({ standings: [] }));
    const producer = createScoringHandlers(as("event_producer"), svc({ getStandings: getStandings as never }));
    expect((await producer.standings(req("GET", undefined, "https://engine.test/api?roundId=nope"), comp)).status).toBe(400);
    expect((await producer.standings(req("GET", undefined, `https://engine.test/api?roundId=${roundId}`), comp)).status).toBe(200);
    expect(getStandings).toHaveBeenCalledWith(organizationId, competitionId, { roundId });
    const judge = createScoringHandlers(as("judge"), svc());
    expect((await judge.getSheet(req("GET"), { ...perf, performanceId: "bad" })).status).toBe(404);
  });
});
