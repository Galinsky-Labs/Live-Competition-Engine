import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@live-competition-engine/domain";
import { isMatchAction } from "@live-competition-engine/domain/brackets";
import { allowAll, anonymous, denyAll, memberOnly, req, TEST_ACCOUNT, TEST_ORG, TEST_OTHER_ID } from "../../../../../../../lib/test-authorizer";
import { createBracketHandlers, type BracketDeps } from "./handler";

const EVENT = "44444444-4444-4444-8444-444444444444";
const match = {
  id: TEST_OTHER_ID, bracketId: null, round: null, position: null, status: "live" as const, bye: false, expectedSides: 2,
  winnerSlot: null, nextMatchId: null, nextSlot: null, revision: 2, voidReason: null, sides: []
};
const bracket = {
  id: TEST_OTHER_ID, competitionId: EVENT, stageId: null, format: "single_elimination" as const, sideKind: "entry" as const,
  size: 4, status: "active" as const, rounds: 2, matches: [], replayed: false
};

function deps(overrides: Partial<BracketDeps> = {}): BracketDeps {
  return {
    createTeam: vi.fn(async () => ({ id: TEST_OTHER_ID, name: "Crew", participantIds: [] })),
    listTeams: vi.fn(async () => []),
    createBracket: vi.fn(async () => bracket),
    listBrackets: vi.fn(async () => []),
    getBracket: vi.fn(async () => bracket),
    getPublicBracket: vi.fn(async () => bracket),
    createMatch: vi.fn(async () => ({ ...match, status: "scheduled" as const, revision: 1 })),
    actOnMatch: vi.fn(async () => ({ ...match, status: "decided" as const, winnerSlot: 1, revision: 3 })),
    isAction: isMatchAction,
    ...overrides
  };
}

describe("bracket handlers", () => {
  it("creates a bracket (201) and replays idempotently (200)", async () => {
    const d = deps();
    const body = { sides: [{ entryId: TEST_OTHER_ID, seed: 1 }], idempotencyKey: "bracket-key-1" };
    expect((await createBracketHandlers(allowAll(), d).createBracket(req("POST", body), TEST_ORG, EVENT)).status).toBe(201);
    expect(d.createBracket).toHaveBeenCalledWith(TEST_ORG, EVENT, TEST_ACCOUNT, { stageId: undefined, sides: body.sides, idempotencyKey: "bracket-key-1" });
    const replay = deps({ createBracket: vi.fn(async () => ({ ...bracket, replayed: true })) });
    expect((await createBracketHandlers(allowAll(), replay).createBracket(req("POST", body), TEST_ORG, EVENT)).status).toBe(200);
  });

  it("forbids non-producers and maps a disabled feature to 403", async () => {
    const d = deps();
    const handlers = createBracketHandlers(memberOnly(), d);
    expect((await handlers.createBracket(req("POST", {}), TEST_ORG, EVENT)).status).toBe(403);
    expect((await handlers.actOnMatch(req("POST", { action: "start" }, { "if-match": "1" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(403);
    expect(d.createBracket).not.toHaveBeenCalled();
    const disabled = deps({ createBracket: vi.fn(async () => { throw new DomainError("feature_disabled"); }) });
    expect((await createBracketHandlers(allowAll(), disabled).createBracket(req("POST", {}), TEST_ORG, EVENT)).status).toBe(403);
  });

  it("validates match actions, winner slots and If-Match", async () => {
    const d = deps();
    const handlers = createBracketHandlers(allowAll(), d);
    expect((await handlers.actOnMatch(req("POST", { action: "start" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(428);
    expect((await handlers.actOnMatch(req("POST", { action: "forfeit" }, { "if-match": "2" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(400);
    expect((await handlers.actOnMatch(req("POST", { action: "decide", winnerSlot: "a" }, { "if-match": "2" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(400);
    const response = await handlers.actOnMatch(req("POST", { action: "decide", winnerSlot: 1 }, { "if-match": "2" }), TEST_ORG, EVENT, TEST_OTHER_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe("\"3\"");
    expect(d.actOnMatch).toHaveBeenCalledWith(TEST_ORG, EVENT, TEST_OTHER_ID, TEST_ACCOUNT, { action: "decide", winnerSlot: 1 }, 2);
  });

  it("maps lifecycle and seeding errors", async () => {
    for (const [code, status] of [["invalid_state_match_transition", 409], ["match_revision_conflict", 409], ["invalid_bracket_seeds", 400], ["match_not_found", 404]] as const) {
      const d = deps({ actOnMatch: vi.fn(async () => { throw new DomainError(code); }) });
      expect((await createBracketHandlers(allowAll(), d).actOnMatch(req("POST", { action: "start" }, { "if-match": "1" }), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(status);
    }
  });

  it("reads brackets: 404 when missing, public read is anonymous", async () => {
    const missing = createBracketHandlers(allowAll(), deps({ getBracket: vi.fn(async () => null), getPublicBracket: vi.fn(async () => null) }));
    expect((await missing.getBracket(req("GET"), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(404);
    expect((await missing.publicGetBracket(anonymous(), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(404);
    expect((await missing.getBracket(req("GET"), TEST_ORG, EVENT, "x")).status).toBe(404);
    expect((await createBracketHandlers(denyAll(), deps()).publicGetBracket(anonymous(), TEST_ORG, EVENT, TEST_OTHER_ID)).status).toBe(200);
  });

  it("creates teams and standalone matches", async () => {
    const d = deps();
    const handlers = createBracketHandlers(allowAll(), d);
    expect((await handlers.createTeam(req("POST", { name: "Crew", participantIds: [TEST_OTHER_ID] }), TEST_ORG, EVENT)).status).toBe(201);
    const created = await handlers.createMatch(req("POST", { sides: [] }), TEST_ORG, EVENT);
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe("\"1\"");
    const invalid = deps({ createTeam: vi.fn(async () => { throw new DomainError("invalid_team_members"); }) });
    expect((await createBracketHandlers(allowAll(), invalid).createTeam(req("POST", { name: "Crew" }), TEST_ORG, EVENT)).status).toBe(400);
  });
});
