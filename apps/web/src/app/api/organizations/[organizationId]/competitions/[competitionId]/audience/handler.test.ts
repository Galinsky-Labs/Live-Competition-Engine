import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createAudienceHandlers, createBlockedTermHandlers, type AudienceServices } from "./handler";

const organizationId = "11111111-1111-4111-8111-111111111111";
const competitionId = "22222222-2222-4222-8222-222222222222";
const performanceId = "33333333-3333-4333-8333-333333333333";
const pollId = "44444444-4444-4444-8444-444444444444";
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

const services = (overrides: Partial<Record<keyof AudienceServices, unknown>> = {}) => {
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) base[key] = value;
  return new Proxy(base, {
    get: (target, key: string) => target[key] ?? vi.fn(async () => { throw new Error(`unexpected call ${key}`); })
  }) as unknown as AudienceServices;
};

const req = (method: string, body?: unknown, url = "https://engine.example/api") => new Request(url, {
  method,
  headers: { authorization: "Bearer token", "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

describe("audience handlers", () => {
  it("lets a member post chat using the authenticated identity only", async () => {
    const postChatMessage = vi.fn(async () => ({ id: "m", accountId, body: "hi", status: "visible", createdAt: new Date(0) }));
    const handlers = createAudienceHandlers(asMember, services({ postChatMessage }));
    const response = await handlers.postChat(req("POST", { body: "hi", accountId: "someone-else" }), scope);
    expect(response.status).toBe(201);
    expect(postChatMessage).toHaveBeenCalledWith(organizationId, competitionId, accountId, "hi");
  });

  it("rejects anonymous participation with 401 before touching storage", async () => {
    const addReaction = vi.fn();
    const handlers = createAudienceHandlers(anonymous, services({ addReaction }));
    const response = await handlers.postReaction(req("POST", { performanceId, kind: "applause" }), scope);
    expect(response.status).toBe(401);
    expect(addReaction).not.toHaveBeenCalled();
  });

  it("requires event.manage for moderation and poll management (403 for members)", async () => {
    const moderateChatMessage = vi.fn();
    const createPoll = vi.fn();
    const handlers = createAudienceHandlers(asMember, services({ moderateChatMessage, createPoll }));
    expect((await handlers.patchChatMessage(req("PATCH", { action: "hide", reason: "x" }), scope, pollId)).status).toBe(403);
    expect((await handlers.postPoll(req("POST", { question: "Q", options: ["a", "b"] }), scope)).status).toBe(403);
    expect(moderateChatMessage).not.toHaveBeenCalled();
    expect(createPoll).not.toHaveBeenCalled();
  });

  it("maps domain errors: invalid input 400, rate limit 429, disabled feature 403, missing 404, conflict 409", async () => {
    const fail = (code: string) => vi.fn(async () => { throw new DomainError(code); });
    const cases: Array<[string, number]> = [["invalid_message", 400], ["rate_limited", 429], ["feature_disabled", 403], ["competition_not_found", 404], ["vote_conflict", 409], ["consent_required", 400]];
    for (const [code, status] of cases) {
      const handlers = createAudienceHandlers(asMember, services({ postChatMessage: fail(code) }));
      const response = await handlers.postChat(req("POST", { body: "x" }), scope);
      expect(response.status).toBe(status);
      expect((await response.json()).error).toBe(code);
    }
  });

  it("validates identifiers and JSON before calling services", async () => {
    const handlers = createAudienceHandlers(asMember, services());
    expect((await handlers.postReaction(req("POST", { performanceId: "nope", kind: "applause" }), scope)).status).toBe(400);
    expect((await handlers.postPollVote(req("POST", { optionId: performanceId }), scope, "not-a-uuid")).status).toBe(404);
    expect((await handlers.getChat(req("GET"), { organizationId, competitionId: "bad" })).status).toBe(404);
    const bad = new Request("https://engine.example/api", { method: "POST", headers: { authorization: "Bearer t" }, body: "{" });
    expect((await handlers.postChat(bad, scope)).status).toBe(400);
  });

  it("shows moderated chat only to managers", async () => {
    const listChatMessages = vi.fn(async () => []);
    await createAudienceHandlers(asManager, services({ listChatMessages })).getChat(req("GET"), scope);
    await createAudienceHandlers(asMember, services({ listChatMessages })).getChat(req("GET"), scope);
    expect(listChatMessages.mock.calls.map(call => (call as unknown[])[2])).toEqual([{ includeModerated: true }, { includeModerated: false }]);
  });

  it("passes viewer role to poll reads and the revision to poll transitions", async () => {
    const getPoll = vi.fn(async () => ({ id: pollId }));
    const transitionPoll = vi.fn(async () => ({ id: pollId }));
    await createAudienceHandlers(asMember, services({ getPoll })).getPollOne(req("GET"), scope, pollId);
    expect(getPoll).toHaveBeenCalledWith(organizationId, competitionId, pollId, { accountId, isManager: false });
    const response = await createAudienceHandlers(asManager, services({ transitionPoll })).patchPoll(req("PATCH", { action: "open", expectedRevision: 1 }), scope, pollId);
    expect(response.status).toBe(200);
    expect(transitionPoll).toHaveBeenCalledWith(organizationId, competitionId, pollId, accountId, "open", 1);
  });

  it("requires an integer revision for settings updates", async () => {
    const updateAudienceSettings = vi.fn(async () => ({}));
    const handlers = createAudienceHandlers(asManager, services({ updateAudienceSettings }));
    expect((await handlers.putSettings(req("PUT", { termsVersion: "v1" }), scope)).status).toBe(400);
    expect((await handlers.putSettings(req("PUT", { termsVersion: "v1", expectedRevision: 0 }), scope)).status).toBe(200);
  });
});

describe("blocked term handlers", () => {
  it("require tenant.manage", async () => {
    const addBlockedTerm = vi.fn(async () => ({ id: "t", term: "x" }));
    expect((await createBlockedTermHandlers(asMember, services({ addBlockedTerm })).add(req("POST", { term: "x" }), organizationId)).status).toBe(403);
    expect(addBlockedTerm).not.toHaveBeenCalled();
    expect((await createBlockedTermHandlers(asManager, services({ addBlockedTerm })).add(req("POST", { term: "x" }), organizationId)).status).toBe(201);
    expect(addBlockedTerm).toHaveBeenCalledWith(organizationId, accountId, "x");
  });

  it("returns 404 for unknown terms", async () => {
    const removeBlockedTerm = vi.fn(async () => { throw new DomainError("blocked_term_not_found"); });
    const response = await createBlockedTermHandlers(asManager, services({ removeBlockedTerm })).remove(req("DELETE"), organizationId, pollId);
    expect(response.status).toBe(404);
  });
});
