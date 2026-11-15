import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createSelectionHandlers, type SelectionService } from "./handlers";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const roundId = "33333333-3333-4333-8333-333333333333";
const accountId = "44444444-4444-4444-8444-444444444444";
const judgeId = "55555555-5555-4555-8555-555555555555";
const params = { organizationId, competitionId, roundId };

const allow = {
  authorize: vi.fn(async () => ({ accountId, sessionId: "s" })),
  authorizeAction: vi.fn(async () => ({ accountId, sessionId: "s", role: "event_producer" as const, roleGrantId: "g", roleGrantVersion: 1 as const }))
};
const forbidden = {
  authorize: vi.fn(async () => { throw new AuthenticationError("forbidden"); }),
  authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); })
};
const req = (method: string, body?: unknown, url = "https://engine.test/api") => new Request(url, {
  method, headers: { authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body)
});
const svc = (overrides: Partial<SelectionService> = {}) => ({
  getSelectionSummary: vi.fn(), getRoundLineup: vi.fn(), setRoundLineup: vi.fn(), listLineupHistory: vi.fn(),
  getRoundPanel: vi.fn(), assignJudgeToRound: vi.fn(), removeJudgeFromRound: vi.fn(), ...overrides
}) as unknown as SelectionService;

describe("selection console handlers", () => {
  it("saves a lineup as the authenticated producer", async () => {
    const setRoundLineup = vi.fn(async () => ({ roundId, revision: 2, slots: [] }));
    const response = await createSelectionHandlers(allow, svc({ setRoundLineup })).putLineup(req("PUT", { entryIds: [], expectedRevision: 1 }), params);
    expect(response.status).toBe(200);
    expect(setRoundLineup).toHaveBeenCalledWith(organizationId, competitionId, roundId, accountId, { entryIds: [], expectedRevision: 1, reason: undefined });
    expect(allow.authorizeAction).toHaveBeenCalledWith("Bearer t", "event.manage", { organizationId, competitionId });
  });

  it("denies non-producers before touching services", async () => {
    const service = svc();
    const h = createSelectionHandlers(forbidden, service);
    expect((await h.putLineup(req("PUT", { entryIds: [] }), params)).status).toBe(403);
    expect((await h.assignJudge(req("POST", { judgeId }), params)).status).toBe(403);
    expect((await h.summary(req("GET"), { organizationId, competitionId })).status).toBe(403);
    expect(service.setRoundLineup).not.toHaveBeenCalled();
  });

  it("returns 404 for malformed path ids and 400 for bad bodies", async () => {
    const h = createSelectionHandlers(allow, svc());
    expect((await h.getLineup(req("GET"), { ...params, roundId: "x" })).status).toBe(404);
    expect((await h.putLineup(new Request("https://engine.test", { method: "PUT", headers: { authorization: "Bearer t" }, body: "[]" }), params)).status).toBe(400);
  });

  it("maps conflicts and missing records", async () => {
    const h = createSelectionHandlers(allow, svc({
      setRoundLineup: vi.fn(async () => { throw new DomainError("lineup_revision_conflict"); }),
      assignJudgeToRound: vi.fn(async () => { throw new DomainError("panel_head_conflict"); }),
      removeJudgeFromRound: vi.fn(async () => { throw new DomainError("panel_assignment_not_found"); }),
      getRoundLineup: vi.fn(async () => { throw new DomainError("round_not_found"); })
    }));
    expect((await h.putLineup(req("PUT", { entryIds: [], expectedRevision: 0 }), params)).status).toBe(409);
    expect((await h.assignJudge(req("POST", { judgeId, role: "head" }), params)).status).toBe(409);
    expect((await h.removeJudge(req("DELETE", undefined, `https://engine.test/api?judgeId=${judgeId}`), params)).status).toBe(404);
    expect((await h.getLineup(req("GET"), params)).status).toBe(404);
  });
});
