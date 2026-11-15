import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createIntegrityHandlers, type IntegrityServices } from "./integrity-handler";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const windowId = "33333333-3333-4333-8333-333333333333";
const flagId = "44444444-4444-4444-8444-444444444444";
const accountId = "55555555-5555-4555-8555-555555555555";
const scope = { organizationId, competitionId };
const principal = { accountId, sessionId: "s", organizationId };

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

const services = (overrides: Partial<Record<keyof IntegrityServices, unknown>> = {}) =>
  new Proxy({ ...overrides } as Record<string, unknown>, {
    get: (target, name: string) => target[name] ?? vi.fn(async () => { throw new Error(`unexpected ${name}`); })
  }) as unknown as IntegrityServices;

const req = (method: string, body?: unknown, url = "https://engine.example/api") => new Request(url, {
  method,
  headers: { authorization: "Bearer token", "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

describe("voting integrity handlers", () => {
  it("serves inclusion proofs to members by receipt and optional version", async () => {
    const getInclusionProof = vi.fn(async () => ({ included: true }));
    const response = await createIntegrityHandlers(asMember, services({ getInclusionProof }))
      .getProof(req("GET", undefined, "https://engine.example/api?receipt=abc&version=2"), scope, windowId);
    expect(response.status).toBe(200);
    expect(getInclusionProof).toHaveBeenCalledWith(organizationId, competitionId, windowId, "abc", 2);
    const bad = await createIntegrityHandlers(asMember, services()).getProof(req("GET", undefined, "https://engine.example/api?receipt=abc&version=x"), scope, windowId);
    expect(bad.status).toBe(400);
  });

  it("rejects anonymous proof requests", async () => {
    const getInclusionProof = vi.fn();
    expect((await createIntegrityHandlers(anonymous, services({ getInclusionProof })).getProof(req("GET"), scope, windowId)).status).toBe(401);
    expect(getInclusionProof).not.toHaveBeenCalled();
  });

  it("requires event.manage for voids, recounts, snapshots and anomaly review", async () => {
    const handlers = createIntegrityHandlers(asMember, services());
    expect((await handlers.postVoid(req("POST", { receipt: "r", reason: "x" }), scope, windowId)).status).toBe(403);
    expect((await handlers.postRecount(req("POST"), scope, windowId)).status).toBe(403);
    expect((await handlers.listSnapshots(req("GET"), scope, windowId)).status).toBe(403);
    expect((await handlers.patchAnomaly(req("PATCH", { status: "reviewed" }), scope, windowId, flagId)).status).toBe(403);
  });

  it("voids by receipt or ballot id with the actor from the session", async () => {
    const voidBallot = vi.fn(async () => ({ voidId: "v", ballotId: "b", snapshot: null }));
    const handlers = createIntegrityHandlers(asManager, services({ voidBallot }));
    expect((await handlers.postVoid(req("POST", { receipt: "r", reason: "dup" }), scope, windowId)).status).toBe(201);
    expect((await handlers.postVoid(req("POST", { ballotId: windowId, reason: "dup" }), scope, windowId)).status).toBe(201);
    expect(voidBallot.mock.calls.map(call => (call as unknown[]).slice(3))).toEqual([
      [accountId, { receipt: "r" }, "dup"],
      [accountId, { ballotId: windowId }, "dup"]
    ]);
  });

  it("maps integrity errors", async () => {
    const cases: Array<[string, number]> = [["invalid_reason", 400], ["ballot_not_found", 404], ["invalid_state_ballot_not_active", 409], ["receipt_not_found", 404], ["invalid_state_window_not_closed", 409]];
    for (const [code, status] of cases) {
      const voidBallot = vi.fn(async () => { throw new DomainError(code); });
      const response = await createIntegrityHandlers(asManager, services({ voidBallot })).postVoid(req("POST", { receipt: "r", reason: "x" }), scope, windowId);
      expect([code, response.status]).toEqual([code, status]);
    }
  });

  it("validates identifiers before storage and returns 204 for reviews", async () => {
    const reviewAnomalyFlag = vi.fn(async () => undefined);
    const handlers = createIntegrityHandlers(asManager, services({ reviewAnomalyFlag }));
    expect((await handlers.patchAnomaly(req("PATCH", { status: "reviewed" }), scope, windowId, "nope")).status).toBe(404);
    expect((await handlers.postRecount(req("POST"), scope, "nope")).status).toBe(404);
    expect((await handlers.patchAnomaly(req("PATCH", { status: "reviewed", note: "ok" }), scope, windowId, flagId)).status).toBe(204);
    expect(reviewAnomalyFlag).toHaveBeenCalledWith(organizationId, competitionId, windowId, flagId, accountId, "reviewed", "ok");
  });
});
