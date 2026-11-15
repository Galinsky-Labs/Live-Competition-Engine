import { describe, expect, it, vi } from "vitest";
import type { TimerView } from "@live-competition-engine/db/timers";
import { ACCOUNT, COMP, ORG, domainError, fakeAuthorizer, jsonRequest } from "../../../../../../../lib/live-test-helpers";
import { createTimerHandlers, type TimerServices } from "./handler";

const TIMER = "66666666-6666-4666-8666-666666666666";
const view: TimerView = {
  timerId: TIMER, competitionId: COMP, performanceId: null, label: "Set", status: "running", phase: "running",
  durationMs: 60_000, extendedMs: 0, elapsedMs: 1_000, remainingMs: 59_000, overtimeMs: 0, pauseReason: null,
  sequence: 1, serverNow: 1, serverNowIso: "1970-01-01T00:00:00.001Z"
};

function services(overrides: Partial<TimerServices> = {}): TimerServices {
  return {
    createTimer: vi.fn(async () => view),
    listTimers: vi.fn(async () => [view]),
    getTimer: vi.fn(async () => view),
    issueTimerCommand: vi.fn(async () => ({ view, replayed: false })),
    getTimerLog: vi.fn(async () => []),
    ...overrides
  };
}

const producer = fakeAuthorizer(ACCOUNT, ["event.manage"]);
const performer = fakeAuthorizer(ACCOUNT, ["performance.submit"], "performer");

describe("timer handlers", () => {
  it("lets producers issue commands with server time", async () => {
    const svc = services();
    const response = await createTimerHandlers(producer, svc).command(jsonRequest("POST", { type: "extend", amountMs: 5000, idempotencyKey: "idem-123456", expectedSequence: 1 }), ORG, COMP, TIMER);
    expect(response.status).toBe(201);
    expect(svc.issueTimerCommand).toHaveBeenCalledWith(ORG, TIMER, ACCOUNT, {
      type: "extend", amountMs: 5000, durationMs: null, reason: null, idempotencyKey: "idem-123456", expectedSequence: 1
    });
    expect((await response.json()).timer.serverNow).toBe(1);
  });

  it("lets performers read but not command timers", async () => {
    const svc = services();
    const handlers = createTimerHandlers(performer, svc);
    expect((await handlers.get(jsonRequest("GET"), ORG, COMP, TIMER)).status).toBe(200);
    expect((await handlers.command(jsonRequest("POST", { type: "pause", idempotencyKey: "idem-123456" }), ORG, COMP, TIMER)).status).toBe(403);
    expect((await handlers.log(jsonRequest("GET"), ORG, COMP, TIMER)).status).toBe(403);
    expect(svc.issueTimerCommand).not.toHaveBeenCalled();
  });

  it("rejects invalid commands", async () => {
    const handlers = createTimerHandlers(producer, services({
      issueTimerCommand: vi.fn(async () => { throw domainError("invalid_timer_extension"); })
    }));
    expect((await handlers.command(jsonRequest("POST", { idempotencyKey: "idem-123456" }), ORG, COMP, TIMER)).status).toBe(400);
    expect((await handlers.command(jsonRequest("POST", { type: "pause" }), ORG, COMP, TIMER)).status).toBe(400);
    expect((await handlers.command(jsonRequest("POST", { type: "extend", amountMs: 1, idempotencyKey: "idem-123456" }), ORG, COMP, TIMER)).status).toBe(400);
    expect((await handlers.create(jsonRequest("POST", { performanceId: 7, label: "x", durationMs: 1000 }), ORG, COMP)).status).toBe(400);
  });

  it("maps conflicts and missing timers", async () => {
    const conflict = createTimerHandlers(producer, services({
      issueTimerCommand: vi.fn(async () => { throw domainError("invalid_state_timer_paused_pause"); })
    }));
    expect((await conflict.command(jsonRequest("POST", { type: "pause", idempotencyKey: "idem-123456" }), ORG, COMP, TIMER)).status).toBe(409);
    const elsewhere = createTimerHandlers(producer, services({ getTimer: vi.fn(async () => ({ ...view, competitionId: ORG })) }));
    expect((await elsewhere.get(jsonRequest("GET"), ORG, COMP, TIMER)).status).toBe(404);
    const missing = createTimerHandlers(producer, services({ getTimer: vi.fn(async () => { throw domainError("timer_not_found"); }) }));
    expect((await missing.command(jsonRequest("POST", { type: "pause", idempotencyKey: "idem-123456" }), ORG, COMP, TIMER)).status).toBe(404);
    expect((await missing.get(jsonRequest("GET"), ORG, COMP, "bad-id")).status).toBe(404);
  });

  it("returns 200 for an idempotent replay", async () => {
    const handlers = createTimerHandlers(producer, services({ issueTimerCommand: vi.fn(async () => ({ view, replayed: true })) }));
    expect((await handlers.command(jsonRequest("POST", { type: "start", idempotencyKey: "idem-123456" }), ORG, COMP, TIMER)).status).toBe(200);
  });
});
