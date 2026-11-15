import { describe, expect, it, vi } from "vitest";
import { ACCOUNT, COMP, ORG, domainError, fakeAuthorizer, jsonRequest } from "../../../../../../../lib/live-test-helpers";
import { createControlRoomHandlers, type ControlRoomServices } from "./handler";

const ROUND = "77777777-7777-4777-8777-777777777777";
const PERF = "88888888-8888-4888-8888-888888888888";

function services(overrides: Partial<ControlRoomServices> = {}): ControlRoomServices {
  return {
    getControlRoom: vi.fn(async () => ({ show: { state: "standby" }, rounds: [] }) as never),
    changeShowState: vi.fn(async () => ({ state: "running" })),
    safetyStop: vi.fn(async () => ({ state: "paused", pausedTimerIds: [] })),
    createRound: vi.fn(async () => ({ roundId: ROUND, ordinal: 1 })),
    addPerformance: vi.fn(async () => ({ performanceId: PERF, ordinal: 1 })),
    reorderRound: vi.fn(async () => ({ order: [] })),
    transitionRound: vi.fn(async () => ({ roundId: ROUND, status: "live" })),
    transitionPerformance: vi.fn(async () => ({ performanceId: PERF, status: "live" })),
    setRoundPublication: vi.fn(async () => ({ roundId: ROUND, resultsPublished: true, revision: 1 })),
    ...overrides
  };
}

const producer = fakeAuthorizer(ACCOUNT, ["event.manage"]);

describe("control room handlers", () => {
  it("runs producer actions with the authenticated actor", async () => {
    const svc = services();
    const h = createControlRoomHandlers(producer, svc);
    expect((await h.show(jsonRequest("POST", { command: "start", expectedRevision: 3 }), ORG, COMP)).status).toBe(200);
    expect(svc.changeShowState).toHaveBeenCalledWith(ORG, COMP, ACCOUNT, "start", 3);
    expect((await h.safetyStop(jsonRequest("POST", { reason: "medical", actorAccountId: "spoof" }), ORG, COMP)).status).toBe(200);
    expect(svc.safetyStop).toHaveBeenCalledWith(ORG, COMP, ACCOUNT, "medical");
    expect((await h.createRound(jsonRequest("POST", { label: "Final" }), ORG, COMP)).status).toBe(201);
    expect((await h.addPerformance(jsonRequest("POST", { entryId: PERF }), ORG, COMP, ROUND)).status).toBe(201);
    expect((await h.reorder(jsonRequest("PUT", { performanceIds: [PERF] }), ORG, COMP, ROUND)).status).toBe(200);
    expect((await h.roundStatus(jsonRequest("POST", { status: "live" }), ORG, COMP, ROUND)).status).toBe(200);
    expect((await h.performanceStatus(jsonRequest("POST", { status: "live" }), ORG, COMP, PERF)).status).toBe(200);
    expect((await h.publication(jsonRequest("POST", { published: true, expectedRevision: 0 }), ORG, COMP, ROUND)).status).toBe(200);
    expect(svc.setRoundPublication).toHaveBeenCalledWith(ORG, COMP, ACCOUNT, ROUND, { published: true, expectedRevision: 0 });
    expect((await h.view(jsonRequest("GET"), ORG, COMP)).status).toBe(200);
  });

  it("forbids judges and performers", async () => {
    const svc = services();
    for (const actions of [["judging.score"], ["performance.submit"]] as const) {
      const h = createControlRoomHandlers(fakeAuthorizer(ACCOUNT, actions, "judge"), svc);
      expect((await h.safetyStop(jsonRequest("POST", { reason: "x" }), ORG, COMP)).status).toBe(403);
      expect((await h.view(jsonRequest("GET"), ORG, COMP)).status).toBe(403);
      expect((await h.publication(jsonRequest("POST", { published: true }), ORG, COMP, ROUND)).status).toBe(403);
    }
    expect(svc.safetyStop).not.toHaveBeenCalled();
    expect(svc.setRoundPublication).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const h = createControlRoomHandlers(producer, services({
      safetyStop: vi.fn(async () => { throw domainError("invalid_reason"); })
    }));
    expect((await h.show(jsonRequest("POST", { command: "explode" }), ORG, COMP)).status).toBe(400);
    expect((await h.safetyStop(jsonRequest("POST", {}), ORG, COMP)).status).toBe(400);
    const malformed = new Request("https://engine.test/x", { method: "POST", headers: { authorization: "Bearer t" }, body: "{" });
    expect((await h.createRound(malformed, ORG, COMP)).status).toBe(400);
  });

  it("maps not-found and state conflicts", async () => {
    const h = createControlRoomHandlers(producer, services({
      transitionRound: vi.fn(async () => { throw domainError("round_not_found"); }),
      transitionPerformance: vi.fn(async () => { throw domainError("invalid_state_performance_already_live"); }),
      reorderRound: vi.fn(async () => { throw domainError("show_revision_conflict"); })
    }));
    expect((await h.roundStatus(jsonRequest("POST", { status: "live" }), ORG, COMP, ROUND)).status).toBe(404);
    expect((await h.performanceStatus(jsonRequest("POST", { status: "live" }), ORG, COMP, PERF)).status).toBe(409);
    expect((await h.reorder(jsonRequest("PUT", { performanceIds: [] }), ORG, COMP, ROUND)).status).toBe(409);
    expect((await h.view(jsonRequest("GET"), ORG, "x")).status).toBe(404);
  });
});
