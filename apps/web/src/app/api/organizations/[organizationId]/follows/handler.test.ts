import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@live-competition-engine/domain";
import { allowAll, anonymous, denyAll, req, TEST_ACCOUNT, TEST_ORG, TEST_OTHER_ID } from "../../../../../lib/test-authorizer";
import { createFollowHandlers, type FollowDeps } from "./handler";

const record = {
  id: TEST_OTHER_ID, targetType: "competition" as const, targetId: TEST_OTHER_ID,
  notifyConsent: false, notifyConsentAt: null, createdAt: new Date(0)
};

function deps(overrides: Partial<FollowDeps> = {}): FollowDeps {
  return {
    parseTarget: vi.fn(input => {
      if (input.targetType !== "competition") throw new DomainError("invalid_follow_target");
      return { type: "competition" as const, id: String(input.targetId) };
    }),
    follow: vi.fn(async () => ({ follow: record, created: true })),
    unfollow: vi.fn(async () => ({ removed: true })),
    setConsent: vi.fn(async () => ({ ...record, notifyConsent: true })),
    listMine: vi.fn(async () => ({ follows: [record], next: null })),
    count: vi.fn(async () => 3),
    ...overrides
  };
}
const target = { targetType: "competition", targetId: TEST_OTHER_ID };
const countUrl = `https://engine.test/api?targetType=competition&targetId=${TEST_OTHER_ID}`;

describe("follow handlers", () => {
  it("follows as the session account (201 new, 200 existing)", async () => {
    const d = deps();
    const response = await createFollowHandlers(allowAll(), d).follow(req("POST", { ...target, accountId: "spoofed" }), TEST_ORG);
    expect(response.status).toBe(201);
    expect(d.follow).toHaveBeenCalledWith(TEST_ORG, TEST_ACCOUNT, { type: "competition", id: TEST_OTHER_ID });
    const again = createFollowHandlers(allowAll(), deps({ follow: vi.fn(async () => ({ follow: record, created: false })) }));
    expect((await again.follow(req("POST", target), TEST_ORG)).status).toBe(200);
  });

  it("rejects non-members and invalid targets", async () => {
    const d = deps();
    expect((await createFollowHandlers(denyAll(), d).follow(req("POST", target), TEST_ORG)).status).toBe(403);
    expect(d.follow).not.toHaveBeenCalled();
    expect((await createFollowHandlers(allowAll(), d).follow(req("POST", { targetType: "user" }), TEST_ORG)).status).toBe(400);
  });

  it("maps a hidden or foreign target and a disabled feature", async () => {
    const missing = deps({ follow: vi.fn(async () => { throw new DomainError("follow_target_not_found"); }) });
    expect((await createFollowHandlers(allowAll(), missing).follow(req("POST", target), TEST_ORG)).status).toBe(404);
    const disabled = deps({ follow: vi.fn(async () => { throw new DomainError("feature_disabled"); }) });
    expect((await createFollowHandlers(allowAll(), disabled).follow(req("POST", target), TEST_ORG)).status).toBe(403);
  });

  it("unfollows by query parameters", async () => {
    const d = deps();
    const response = await createFollowHandlers(allowAll(), d).unfollow(req("DELETE", undefined, {}, countUrl), TEST_ORG);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
  });

  it("requires an explicit boolean for notification consent", async () => {
    const d = deps();
    const handlers = createFollowHandlers(allowAll(), d);
    expect((await handlers.consent(req("PUT", { ...target, notify: "yes" }), TEST_ORG)).status).toBe(400);
    expect((await handlers.consent(req("PUT", { ...target, notify: true }), TEST_ORG)).status).toBe(200);
    expect(d.setConsent).toHaveBeenCalledWith(TEST_ORG, TEST_ACCOUNT, { type: "competition", id: TEST_OTHER_ID }, true);
    const notFollowing = deps({ setConsent: vi.fn(async () => { throw new DomainError("follow_not_found"); }) });
    expect((await createFollowHandlers(allowAll(), notFollowing).consent(req("PUT", { ...target, notify: true }), TEST_ORG)).status).toBe(404);
  });

  it("public count is anonymous and returns only a number", async () => {
    const d = deps();
    const response = await createFollowHandlers(denyAll(), d).count(anonymous(countUrl), TEST_ORG, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ targetType: "competition", targetId: TEST_OTHER_ID, followers: 3 });
    expect(d.count).toHaveBeenCalledWith(TEST_ORG, { type: "competition", id: TEST_OTHER_ID }, null);
    const hidden = deps({ count: vi.fn(async () => null) });
    expect((await createFollowHandlers(denyAll(), hidden).count(anonymous(countUrl), TEST_ORG, true)).status).toBe(404);
  });

  it("lists only the caller's follows", async () => {
    const d = deps();
    expect((await createFollowHandlers(allowAll(), d).list(req("GET"), TEST_ORG)).status).toBe(200);
    expect(d.listMine).toHaveBeenCalledWith(TEST_ORG, TEST_ACCOUNT, {});
  });
});
