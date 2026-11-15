import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { createCmsHandlers, type CmsService } from "./handlers";

const org = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const principal = { accountId: "33333333-3333-4333-8333-333333333333", sessionId: "s", organizationId: org, role: "tenant_operator" as const, roleGrantId: "g", roleGrantVersion: 1 as const };
const editor = { authorize: vi.fn(), authorizeAction: vi.fn(async () => principal) };
const nobody = { authorize: vi.fn(), authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };

function service(overrides: Partial<CmsService> = {}): CmsService {
  return {
    listPages: vi.fn(async () => []), createPage: vi.fn(async () => ({ id: pageId })), getPageForEditing: vi.fn(async () => null),
    updateDraft: vi.fn(async () => ({ draftRevision: 2 })), publishPage: vi.fn(async () => ({ version: 1 })),
    rollbackPage: vi.fn(async () => ({ version: 3 })), schedulePublish: vi.fn(async () => ({})), cancelScheduledPublish: vi.fn(async () => undefined),
    setNavigation: vi.fn(async () => ({ count: 0 })), listNavigation: vi.fn(async () => []), getPublishedPage: vi.fn(async () => null),
    ...overrides
  };
}

const req = (method: string, body?: unknown) => new Request("https://engine.test/api/x", {
  method, headers: { authorization: "Bearer t" }, body: body === undefined ? undefined : JSON.stringify(body)
});

describe("cms handlers", () => {
  it("creates and publishes pages for tenant managers", async () => {
    const svc = service();
    const handlers = createCmsHandlers(editor, svc);
    expect((await handlers.createPage(req("POST", { slug: "about", title: "About" }), org)).status).toBe(201);
    expect((await handlers.publish(req("POST", { expectedDraftRevision: 1 }), org, pageId)).status).toBe(201);
    expect(svc.publishPage).toHaveBeenCalledWith(org, principal.accountId, pageId, { expectedDraftRevision: 1 });
  });

  it("refuses non-managers", async () => {
    const svc = service();
    expect((await createCmsHandlers(nobody, svc).publish(req("POST", { expectedDraftRevision: 1 }), org, pageId)).status).toBe(403);
    expect(svc.publishPage).not.toHaveBeenCalled();
  });

  it("maps disabled feature, conflicts, invalid input and missing pages", async () => {
    const handlers = createCmsHandlers(editor, service({
      createPage: vi.fn(async () => { throw new DomainError("feature_disabled"); }),
      updateDraft: vi.fn(async () => { throw new DomainError("draft_revision_conflict"); }),
      rollbackPage: vi.fn(async () => { throw new DomainError("version_not_found"); }),
      setNavigation: vi.fn(async () => { throw new DomainError("invalid_navigation_target"); })
    }));
    expect((await handlers.createPage(req("POST", { slug: "a", title: "A" }), org)).status).toBe(403);
    expect((await handlers.updateDraft(req("PUT", { title: "x", expectedRevision: 1 }), org, pageId)).status).toBe(409);
    expect((await handlers.rollback(req("POST", { version: 9 }), org, pageId)).status).toBe(404);
    expect((await handlers.setNavigation(req("PUT", { entries: [{ label: "x", url: "javascript:1" }] }), org)).status).toBe(400);
    expect((await handlers.getPage(req("GET"), org, pageId)).status).toBe(404);
  });

  it("serves only published public projections", async () => {
    const svc = service({
      getPublishedPage: vi.fn(async (_org: string, slug: string) => slug === "about"
        ? { pageId, slug, title: "About", html: "<p>x</p>", version: 2, publishedAt: new Date("2026-01-01T00:00:00Z"), mediaIds: [] }
        : null)
    });
    const handlers = createCmsHandlers(nobody, svc);
    const ok = await handlers.publicPage(new Request("https://x"), org, "about");
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json()).sort()).toEqual(["html", "mediaIds", "publishedAt", "slug", "title", "version"]);
    expect((await handlers.publicPage(new Request("https://x"), org, "missing")).status).toBe(404);
    expect((await handlers.publicPage(new Request("https://x"), "bad", "about")).status).toBe(404);
  });
});
