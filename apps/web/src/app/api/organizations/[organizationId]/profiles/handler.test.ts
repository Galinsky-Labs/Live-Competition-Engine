import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@live-competition-engine/domain";
import { allowAll, anonymous, denyAll, memberOnly, req, TEST_ACCOUNT, TEST_ORG, TEST_OTHER_ID } from "../../../../../lib/test-authorizer";
import { createProfileHandlers, type ProfileDeps } from "./handler";

const view = { id: TEST_OTHER_ID, revision: 2, displayName: "Name", bio: "", roles: ["performer" as const], history: [], hidden: false };

function deps(overrides: Partial<ProfileDeps> = {}): ProfileDeps {
  return {
    read: vi.fn(async () => view),
    list: vi.fn(async () => ({ profiles: [], next: null })),
    parsePatch: vi.fn(body => body as never),
    edit: vi.fn(async () => view),
    moderate: vi.fn(async () => ({ id: TEST_OTHER_ID, hidden: true })),
    linkParticipant: vi.fn(async () => ({ participantId: TEST_OTHER_ID, accountId: TEST_ACCOUNT })),
    publicEnabled: vi.fn(async () => true),
    ...overrides
  };
}
const body = { displayName: "Name", bio: "", roles: ["performer"], visibility: "public" };

describe("profile handlers", () => {
  it("lets the authenticated owner update with If-Match and returns an ETag", async () => {
    const d = deps();
    const response = await createProfileHandlers(allowAll(), d).put(req("PUT", body, { "if-match": "\"1\"" }), TEST_ORG, TEST_OTHER_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe("\"2\"");
    expect(d.edit).toHaveBeenCalledWith(TEST_ORG, TEST_OTHER_ID, TEST_ACCOUNT, body, 1);
  });

  it("creates without If-Match (201) and rejects malformed If-Match", async () => {
    const handlers = createProfileHandlers(allowAll(), deps());
    expect((await handlers.put(req("PUT", body), TEST_ORG, TEST_OTHER_ID)).status).toBe(201);
    expect((await handlers.put(req("PUT", body, { "if-match": "abc" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(400);
  });

  it("maps domain failures: forbidden, conflict, invalid", async () => {
    for (const [code, status] of [["forbidden", 403], ["profile_revision_conflict", 409], ["invalid_profile", 400], ["profile_not_found", 404]] as const) {
      const d = deps({ edit: vi.fn(async () => { throw new DomainError(code); }) });
      const response = await createProfileHandlers(allowAll(), d).put(req("PUT", body, { "if-match": "1" }), TEST_ORG, TEST_OTHER_ID);
      expect(response.status).toBe(status);
    }
  });

  it("denies non-members before touching storage", async () => {
    const d = deps();
    const response = await createProfileHandlers(denyAll(), d).put(req("PUT", body), TEST_ORG, TEST_OTHER_ID);
    expect(response.status).toBe(403);
    expect(d.edit).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown or malformed profile ids", async () => {
    const handlers = createProfileHandlers(allowAll(), deps({ read: vi.fn(async () => null) }));
    expect((await handlers.get(req("GET"), TEST_ORG, TEST_OTHER_ID)).status).toBe(404);
    expect((await handlers.get(req("GET"), TEST_ORG, "not-a-uuid")).status).toBe(404);
    expect((await handlers.publicGet(anonymous(), TEST_ORG, TEST_OTHER_ID)).status).toBe(404);
  });

  it("public endpoints read anonymously, strip moderation state and obey the public_profiles flag", async () => {
    const d = deps();
    const handlers = createProfileHandlers(denyAll(), d);
    const response = await handlers.publicGet(anonymous(), TEST_ORG, TEST_OTHER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("hidden");
    expect(d.read).toHaveBeenCalledWith(TEST_ORG, TEST_OTHER_ID, null);

    const disabled = createProfileHandlers(denyAll(), deps({ publicEnabled: vi.fn(async () => false) }));
    expect((await disabled.publicGet(anonymous(), TEST_ORG, TEST_OTHER_ID)).status).toBe(404);
    expect((await disabled.publicList(anonymous(), TEST_ORG)).status).toBe(403);
    expect((await disabled.list(anonymous(), TEST_ORG)).status).toBe(403);
  });

  it("members list without the public flag; anonymous list passes null viewer", async () => {
    const d = deps({ publicEnabled: vi.fn(async () => false) });
    const response = await createProfileHandlers(allowAll(), d).list(req("GET", undefined, {}, "https://engine.test/api?limit=5"), TEST_ORG);
    expect(response.status).toBe(200);
    expect(d.list).toHaveBeenCalledWith(TEST_ORG, TEST_ACCOUNT, { limit: 5 });
  });

  it("moderation requires tenant.manage and validates input", async () => {
    const d = deps();
    expect((await createProfileHandlers(memberOnly(), d).moderate(req("POST", { hidden: true }), TEST_ORG, TEST_OTHER_ID)).status).toBe(403);
    expect(d.moderate).not.toHaveBeenCalled();
    const handlers = createProfileHandlers(allowAll(), d);
    expect((await handlers.moderate(req("POST", { hidden: "yes" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(400);
    expect((await handlers.moderate(req("POST", { hidden: true, reason: "spam" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(200);
    expect(d.moderate).toHaveBeenCalledWith(TEST_ORG, TEST_OTHER_ID, TEST_ACCOUNT, { hidden: true, reason: "spam" });
  });

  it("participant links require tenant.manage and a uuid or null account", async () => {
    const d = deps();
    expect((await createProfileHandlers(memberOnly(), d).linkParticipant(req("PUT", { accountId: null }), TEST_ORG, TEST_OTHER_ID)).status).toBe(403);
    const handlers = createProfileHandlers(allowAll(), d);
    expect((await handlers.linkParticipant(req("PUT", { accountId: "x" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(400);
    expect((await handlers.linkParticipant(req("PUT", { accountId: TEST_ACCOUNT }), TEST_ORG, TEST_OTHER_ID)).status).toBe(200);
  });
});
