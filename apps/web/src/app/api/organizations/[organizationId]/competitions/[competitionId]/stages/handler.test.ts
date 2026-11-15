import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@live-competition-engine/domain";
import { allowAll, memberOnly, req, TEST_ACCOUNT, TEST_ORG, TEST_OTHER_ID } from "../../../../../../../lib/test-authorizer";
import { createStageHandlers, type StageDeps } from "./handler";

const EVENT = "44444444-4444-4444-8444-444444444444";
const stage = {
  id: TEST_OTHER_ID, competitionId: EVENT, roundId: TEST_OTHER_ID, ordinal: 1, roundStatus: "scheduled", revision: 2,
  decided: false, label: "Heat", kind: "heat" as const, customLabel: null, timed: false, durationSeconds: null, advancement: null
};
const decision = {
  id: TEST_OTHER_ID, stageId: TEST_OTHER_ID, contract: { type: "manual" as const }, standings: [], advancing: [], eliminated: [],
  tieBroken: false, tiedAtCut: [], decidedByAccountId: TEST_ACCOUNT, decidedAt: new Date(0), replayed: false
};

function deps(overrides: Partial<StageDeps> = {}): StageDeps {
  return {
    list: vi.fn(async () => [stage]), create: vi.fn(async () => stage), update: vi.fn(async () => ({ ...stage, revision: 3 })),
    reorder: vi.fn(async () => [stage]), decide: vi.fn(async () => decision), getDecision: vi.fn(async () => null),
    ...overrides
  };
}

describe("stage handlers", () => {
  it("creates stages with event.manage scoped to the competition", async () => {
    const authorizer = allowAll();
    const spy = vi.spyOn(authorizer, "authorizeAction");
    const d = deps();
    const response = await createStageHandlers(authorizer, d).create(req("POST", { label: "Heat", kind: "heat", timed: false }), TEST_ORG, EVENT);
    expect(response.status).toBe(201);
    expect(spy).toHaveBeenCalledWith("Bearer test", "event.manage", { organizationId: TEST_ORG, competitionId: EVENT });
  });

  it("forbids non-producers", async () => {
    const d = deps();
    const handlers = createStageHandlers(memberOnly(), d);
    expect((await handlers.create(req("POST", {}), TEST_ORG, EVENT)).status).toBe(403);
    expect((await handlers.decide(req("POST", { idempotencyKey: "key-12345" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(403);
    expect(d.create).not.toHaveBeenCalled();
    expect(d.decide).not.toHaveBeenCalled();
  });

  it("maps invalid definitions and requires If-Match for updates", async () => {
    const invalid = deps({ create: vi.fn(async () => { throw new DomainError("invalid_stage_kind"); }) });
    const handlers = createStageHandlers(allowAll(), invalid);
    expect((await handlers.create(req("POST", { kind: "x" }), TEST_ORG, EVENT)).status).toBe(400);
    expect((await handlers.update(req("PATCH", { label: "x" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(428);
    const ok = await createStageHandlers(allowAll(), deps()).update(req("PATCH", { label: "x" }, { "if-match": "2" }), TEST_ORG, EVENT, TEST_OTHER_ID);
    expect(ok.headers.get("etag")).toBe("\"3\"");
    const decided = deps({ update: vi.fn(async () => { throw new DomainError("invalid_state_stage_decided"); }) });
    expect((await createStageHandlers(allowAll(), decided).update(req("PATCH", { label: "x" }, { "if-match": "2" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(409);
  });

  it("passes the reorder payload through to domain validation", async () => {
    const d = deps({ reorder: vi.fn(async () => { throw new DomainError("invalid_stage_order"); }) });
    expect((await createStageHandlers(allowAll(), d).reorder(req("PUT", { stageIds: ["x"] }), TEST_ORG, EVENT)).status).toBe(400);
    expect(d.reorder).toHaveBeenCalledWith(TEST_ORG, EVENT, TEST_ACCOUNT, ["x"]);
  });

  it("records advancement with an idempotency key (body or header)", async () => {
    const d = deps();
    const handlers = createStageHandlers(allowAll(), d);
    expect((await handlers.decide(req("POST", {}), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(400);
    expect((await handlers.decide(req("POST", { idempotencyKey: "key-12345", selection: ["bad"] }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(400);
    expect((await handlers.decide(req("POST", {}, { "idempotency-key": "key-12345" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(201);
    const replay = deps({ decide: vi.fn(async () => ({ ...decision, replayed: true })) });
    expect((await createStageHandlers(allowAll(), replay).decide(req("POST", { idempotencyKey: "key-12345" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(200);
    const conflict = deps({ decide: vi.fn(async () => { throw new DomainError("stage_advancement_conflict"); }) });
    expect((await createStageHandlers(allowAll(), conflict).decide(req("POST", { idempotencyKey: "key-12345" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(409);
  });

  it("returns 404 for unknown stages and missing decisions", async () => {
    const handlers = createStageHandlers(allowAll(), deps({ update: vi.fn(async () => { throw new DomainError("stage_not_found"); }) }));
    expect((await handlers.update(req("PATCH", {}, { "if-match": "1" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(404);
    expect((await handlers.update(req("PATCH", {}, { "if-match": "1" }), TEST_ORG, EVENT, "nope")).status).toBe(404);
    expect((await handlers.getDecision(req("GET"), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(404);
  });
});
