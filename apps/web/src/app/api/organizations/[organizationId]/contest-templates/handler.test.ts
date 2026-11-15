import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@live-competition-engine/domain";
import { parseTemplateConfig, parseTemplateName } from "@live-competition-engine/domain/contest-templates";
import { allowAll, memberOnly, req, TEST_ACCOUNT, TEST_ORG, TEST_OTHER_ID } from "../../../../../lib/test-authorizer";
import { createTemplateHandlers, type TemplateDeps } from "./handler";

const version = { id: TEST_OTHER_ID, version: 1, status: "draft" as const, revision: 2, configHash: "h", config: {} as never, createdAt: new Date(0), publishedAt: null };
const template = { id: TEST_OTHER_ID, name: "Format", createdAt: new Date(0), versions: [version] };

function deps(overrides: Partial<TemplateDeps> = {}): TemplateDeps {
  return {
    parseName: parseTemplateName,
    create: vi.fn(async (_org, _actor, input) => { parseTemplateConfig(input.config); return template; }),
    get: vi.fn(async () => template),
    list: vi.fn(async () => []),
    saveDraft: vi.fn(async () => version),
    publish: vi.fn(async () => ({ ...version, status: "published" as const })),
    apply: vi.fn(async () => ({ competitionId: TEST_OTHER_ID, templateVersionId: TEST_OTHER_ID, templateId: TEST_OTHER_ID, version: 1, configHash: "h", snapshot: {} as never, appliedAt: new Date(0), eventRevision: 3 })),
    getApplied: vi.fn(async () => ({ eventRevision: 3, snapshot: null })),
    ...overrides
  };
}

describe("contest template handlers", () => {
  it("returns validation issues for invalid configs", async () => {
    const response = await createTemplateHandlers(allowAll(), deps()).create(req("POST", { name: "Format", config: { format: {} } }), TEST_ORG);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_template_config");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("requires event.manage for every template operation", async () => {
    const d = deps();
    const handlers = createTemplateHandlers(memberOnly(), d);
    for (const response of [
      await handlers.list(req("GET"), TEST_ORG),
      await handlers.create(req("POST", { name: "x", config: {} }), TEST_ORG),
      await handlers.saveDraft(req("PUT", { config: {} }), TEST_ORG, TEST_OTHER_ID),
      await handlers.publish(req("POST", undefined, { "if-match": "1" }), TEST_ORG, TEST_OTHER_ID),
      await handlers.apply(req("PUT", { templateVersionId: TEST_OTHER_ID }, { "if-match": "1" }), TEST_ORG, TEST_OTHER_ID)
    ]) {
      expect(response.status).toBe(403);
    }
    expect(d.saveDraft).not.toHaveBeenCalled();
  });

  it("saves drafts with optional If-Match and publishes with a required one", async () => {
    const d = deps();
    const handlers = createTemplateHandlers(allowAll(), d);
    expect((await handlers.saveDraft(req("PUT", { config: {} }), TEST_ORG, TEST_OTHER_ID)).status).toBe(201);
    const updated = await handlers.saveDraft(req("PUT", { config: {} }, { "if-match": "\"1\"" }), TEST_ORG, TEST_OTHER_ID);
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe("\"2\"");
    expect(d.saveDraft).toHaveBeenLastCalledWith(TEST_ORG, TEST_OTHER_ID, TEST_ACCOUNT, {}, 1);
    expect((await handlers.publish(req("POST"), TEST_ORG, TEST_OTHER_ID)).status).toBe(428);
    expect((await handlers.publish(req("POST", undefined, { "if-match": "2" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(200);
  });

  it("maps conflicts and missing templates", async () => {
    const conflict = deps({ publish: vi.fn(async () => { throw new DomainError("contest_template_revision_conflict"); }) });
    expect((await createTemplateHandlers(allowAll(), conflict).publish(req("POST", undefined, { "if-match": "1" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(409);
    const missing = createTemplateHandlers(allowAll(), deps({ get: vi.fn(async () => null) }));
    expect((await missing.get(req("GET"), TEST_ORG, TEST_OTHER_ID)).status).toBe(404);
    expect((await missing.get(req("GET"), TEST_ORG, "nope")).status).toBe(404);
  });

  it("applies a template version to an event with the event revision", async () => {
    const d = deps();
    const handlers = createTemplateHandlers(allowAll(), d);
    expect((await handlers.apply(req("PUT", { templateVersionId: "x" }, { "if-match": "2" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(400);
    expect((await handlers.apply(req("PUT", { templateVersionId: TEST_OTHER_ID }), TEST_ORG, TEST_OTHER_ID)).status).toBe(428);
    const response = await handlers.apply(req("PUT", { templateVersionId: TEST_OTHER_ID }, { "if-match": "2" }), TEST_ORG, TEST_OTHER_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe("\"3\"");
    const started = deps({ apply: vi.fn(async () => { throw new DomainError("invalid_state_event_started"); }) });
    expect((await createTemplateHandlers(allowAll(), started).apply(req("PUT", { templateVersionId: TEST_OTHER_ID }, { "if-match": "2" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(409);
  });
});
