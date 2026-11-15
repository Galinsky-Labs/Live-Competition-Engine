import { describe, expect, it, vi } from "vitest";
import type { BackstageMessage } from "@live-competition-engine/db/backstage";
import { ACCOUNT, COMP, ORG, domainError, fakeAuthorizer, jsonRequest } from "../../../../../../../lib/live-test-helpers";
import { createBackstageHandlers, type BackstageServices } from "./handler";

const PERF = "55555555-5555-4555-8555-555555555555";
const message: BackstageMessage = {
  id: "m", seq: 1, kind: "cue", performanceId: PERF, entryId: null, readiness: null, body: "Go", refSeq: null,
  authorRole: "producer", mine: true, createdAt: ""
};

function services(overrides: Partial<BackstageServices> = {}): BackstageServices {
  return {
    listBackstageMessages: vi.fn(async () => ({ messages: [message], cursor: 1, hasMore: false })),
    postCheckin: vi.fn(async () => message),
    postCue: vi.fn(async () => message),
    acknowledgeCue: vi.fn(async () => message),
    postJudgeMessage: vi.fn(async () => message),
    getReadiness: vi.fn(async () => []),
    setEntryAccountLink: vi.fn(async input => input),
    getRunOfShow: vi.fn(async () => []),
    ...overrides
  };
}

const get = (path: string) => new Request(`https://engine.test${path}`, { headers: { authorization: "Bearer t" } });

describe("backstage handlers", () => {
  it("resolves the most privileged role and passes it to the feed", async () => {
    const svc = services();
    const judge = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["judging.score", "performance.submit"], "judge"), svc);
    const response = await judge.messages(get("/x?since=7"), ORG, COMP);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.role).toBe("judge");
    expect(body.serverNow).toBeTypeOf("string");
    expect(svc.listBackstageMessages).toHaveBeenCalledWith(ORG, COMP, { accountId: ACCOUNT, role: "judge" }, 7);
  });

  it("rejects callers with no live role and unauthenticated callers", async () => {
    const svc = services();
    const viewer = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["content.view_private"], "viewer"), svc);
    expect((await viewer.messages(get("/x"), ORG, COMP)).status).toBe(403);
    const anonymous = await viewer.messages(new Request("https://engine.test/x"), ORG, COMP);
    expect(anonymous.status).toBe(401);
    expect(svc.listBackstageMessages).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const performer = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["performance.submit"], "performer"), services());
    expect((await performer.messages(get("/x?since=abc"), ORG, COMP)).status).toBe(400);
    expect((await performer.checkin(jsonRequest("POST", { readiness: "ready", idempotencyKey: "idem-123456" }), ORG, COMP)).status).toBe(400);
    expect((await performer.checkin(jsonRequest("POST", { performanceId: PERF, readiness: "ready" }), ORG, COMP)).status).toBe(400);
    const producer = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["event.manage"]), services());
    expect((await producer.link(jsonRequest("POST", { entryId: PERF }), ORG, COMP)).status).toBe(400);
  });

  it("maps service-level ownership and state failures", async () => {
    const performer = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["performance.submit"], "performer"), services({
      postCue: vi.fn(async () => { throw domainError("forbidden"); }),
      acknowledgeCue: vi.fn(async () => { throw domainError("cue_not_found"); }),
      postCheckin: vi.fn(async () => { throw domainError("rate_limited"); })
    }));
    expect((await performer.cue(jsonRequest("POST", { performanceId: PERF, body: "x", idempotencyKey: "idem-123456" }), ORG, COMP)).status).toBe(403);
    expect((await performer.ack(jsonRequest("POST", { idempotencyKey: "idem-123456" }), ORG, COMP, PERF)).status).toBe(404);
    expect((await performer.checkin(jsonRequest("POST", { performanceId: PERF, readiness: "ready", idempotencyKey: "idem-123456" }), ORG, COMP)).status).toBe(429);
  });

  it("restricts readiness and links to producers", async () => {
    const svc = services();
    const judge = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["judging.score"], "judge"), svc);
    expect((await judge.readiness(get("/x"), ORG, COMP)).status).toBe(403);
    expect((await judge.link(jsonRequest("POST", { entryId: PERF, accountId: ACCOUNT, linked: true }), ORG, COMP)).status).toBe(403);
    const producer = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["event.manage"]), svc);
    expect((await producer.link(jsonRequest("POST", { entryId: PERF, accountId: ACCOUNT, linked: true }), ORG, COMP)).status).toBe(200);
    expect(svc.setEntryAccountLink).toHaveBeenCalledWith(ORG, COMP, ACCOUNT, { entryId: PERF, accountId: ACCOUNT, linked: true });
    const cue = await producer.cue(jsonRequest("POST", { performanceId: PERF, body: "Go", idempotencyKey: "idem-123456" }), ORG, COMP);
    expect(cue.status).toBe(201);
  });

  it("returns 404 for a malformed competition id", async () => {
    const producer = createBackstageHandlers(fakeAuthorizer(ACCOUNT, ["event.manage"]), services());
    expect((await producer.runOfShow(get("/x"), ORG, "nope")).status).toBe(404);
  });
});
