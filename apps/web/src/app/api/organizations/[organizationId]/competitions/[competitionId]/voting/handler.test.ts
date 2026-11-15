import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createVotingHandlers, type VotingServices } from "./handler";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const windowId = "33333333-3333-4333-8333-333333333333";
const accountId = "55555555-5555-4555-8555-555555555555";
const sessionId = "66666666-6666-4666-8666-666666666666";
const scope = { organizationId, competitionId };
const principal = { accountId, sessionId, organizationId };

const asManager = {
  authorize: vi.fn(async () => principal),
  authorizeAction: vi.fn(async () => ({ ...principal, role: "event_producer" as const, roleGrantId: "g", roleGrantVersion: 1 as const }))
};
const asMember = {
  authorize: vi.fn(async () => principal),
  authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); })
};
const anonymous = {
  authorize: vi.fn(async () => { throw new AuthenticationError("missing"); }),
  authorizeAction: vi.fn(async () => { throw new AuthenticationError("missing"); })
};

const services = (overrides: Partial<Record<keyof VotingServices, unknown>> = {}) =>
  new Proxy({ ...overrides } as Record<string, unknown>, {
    get: (target, name: string) => target[name] ?? vi.fn(async () => { throw new Error(`unexpected ${name}`); })
  }) as unknown as VotingServices;

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) => new Request("https://engine.example/api", {
  method,
  headers: { authorization: "Bearer token", "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

describe("voting handlers", () => {
  it("casts a ballot with session identity and the Idempotency-Key header", async () => {
    const castBallot = vi.fn(async () => ({ receipt: "r", replayed: false }));
    const response = await createVotingHandlers(asMember, services({ castBallot })).castBallot(
      req("POST", { choice: { optionId: "x" }, accountId: "spoofed" }, { "idempotency-key": "key-12345678" }), scope, windowId);
    expect(response.status).toBe(201);
    expect(castBallot).toHaveBeenCalledWith(organizationId, competitionId, windowId, { accountId, sessionId }, { optionId: "x" }, "key-12345678");
  });

  it("returns 200 for an idempotent replay", async () => {
    const castBallot = vi.fn(async () => ({ receipt: "r", replayed: true }));
    const response = await createVotingHandlers(asMember, services({ castBallot })).castBallot(req("POST", { choice: {}, idempotencyKey: "key-12345678" }), scope, windowId);
    expect(response.status).toBe(200);
  });

  it("maps eligibility, conflicts, closed windows and missing windows", async () => {
    const cases: Array<[string, number]> = [["voter_not_eligible", 403], ["ballot_voided", 403], ["vote_conflict", 409], ["idempotency_conflict", 409],
      ["invalid_state_window_not_open", 409], ["vote_window_not_found", 404], ["invalid_ballot", 400], ["rate_limited", 429], ["feature_disabled", 403]];
    for (const [code, status] of cases) {
      const castBallot = vi.fn(async () => { throw new DomainError(code); });
      const response = await createVotingHandlers(asMember, services({ castBallot })).castBallot(req("POST", { choice: {} }), scope, windowId);
      expect([code, response.status]).toEqual([code, status]);
    }
  });

  it("rejects anonymous voters with 401 and members managing windows with 403", async () => {
    const castBallot = vi.fn();
    const createVoteWindow = vi.fn();
    const closeVoteWindow = vi.fn();
    expect((await createVotingHandlers(anonymous, services({ castBallot })).castBallot(req("POST", { choice: {} }), scope, windowId)).status).toBe(401);
    expect((await createVotingHandlers(asMember, services({ createVoteWindow })).createWindow(req("POST", {}), scope)).status).toBe(403);
    expect((await createVotingHandlers(asMember, services({ closeVoteWindow })).closeWindow(req("POST"), scope, windowId)).status).toBe(403);
    expect(castBallot).not.toHaveBeenCalled();
    expect(createVoteWindow).not.toHaveBeenCalled();
    expect(closeVoteWindow).not.toHaveBeenCalled();
  });

  it("returns 404 for malformed identifiers without calling storage", async () => {
    const handlers = createVotingHandlers(asManager, services());
    expect((await handlers.getWindow(req("GET"), scope, "nope")).status).toBe(404);
    expect((await handlers.getResults(req("GET"), { organizationId, competitionId: "bad" }, windowId)).status).toBe(404);
    expect((await handlers.closeWindow(req("POST"), scope, "nope")).status).toBe(404);
  });

  it("passes the viewer role to result reads", async () => {
    const getVoteResults = vi.fn(async () => ({ visible: false, phase: "open" }));
    await createVotingHandlers(asMember, services({ getVoteResults })).getResults(req("GET"), scope, windowId);
    await createVotingHandlers(asManager, services({ getVoteResults })).getResults(req("GET"), scope, windowId);
    expect(getVoteResults.mock.calls.map(call => (call as unknown[])[3])).toEqual([{ isManager: false }, { isManager: true }]);
  });

  it("lets managers create and transition windows", async () => {
    const createVoteWindow = vi.fn(async () => ({ id: windowId }));
    const transitionVoteWindow = vi.fn(async () => ({ id: windowId }));
    const handlers = createVotingHandlers(asManager, services({ createVoteWindow, transitionVoteWindow }));
    expect((await handlers.createWindow(req("POST", { label: "x" }), scope)).status).toBe(201);
    expect((await handlers.patchWindow(req("PATCH", { action: "publish", expectedRevision: 1 }), scope, windowId)).status).toBe(200);
    expect(transitionVoteWindow).toHaveBeenCalledWith(organizationId, competitionId, windowId, accountId, "publish", 1);
  });
});
