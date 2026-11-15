import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@live-competition-engine/domain";
import { EVENT_DEFAULTS, isEventStatus, parseEventCreate, parseEventPatch } from "@live-competition-engine/domain/events";
import { allowAll, anonymous, denyAll, memberOnly, req, TEST_ACCOUNT, TEST_ORG, TEST_OTHER_ID } from "../../../../../lib/test-authorizer";
import { createEventHandlers, type EventDeps } from "./handler";

const record = {
  ...EVENT_DEFAULTS, title: "Event", id: TEST_OTHER_ID, organizationId: TEST_ORG, status: "draft" as const, revision: 4,
  publishedAt: null, cancelledAt: null, cancelReason: null, createdAt: new Date(0), updatedAt: new Date(0)
};
const publicEvent = { ...record, slug: "event" };

function deps(overrides: Partial<EventDeps> = {}): EventDeps {
  return {
    parseCreate: parseEventCreate, parsePatch: parseEventPatch, isStatus: isEventStatus,
    create: vi.fn(async () => record), get: vi.fn(async () => record), history: vi.fn(async () => []),
    update: vi.fn(async () => ({ ...record, revision: 5 })), transition: vi.fn(async () => ({ ...record, revision: 5 })),
    getPublic: vi.fn(async () => publicEvent), listPublic: vi.fn(async () => []), listManaged: vi.fn(async () => [record]),
    ...overrides
  };
}

describe("event handlers", () => {
  it("creates an event with tenant-level event.manage", async () => {
    const d = deps();
    const response = await createEventHandlers(allowAll(), d).create(req("POST", { title: "New", timezone: "Asia/Tokyo" }), TEST_ORG);
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe("\"4\"");
    expect(d.create).toHaveBeenCalledWith(TEST_ORG, TEST_ACCOUNT, expect.objectContaining({ title: "New", timezone: "Asia/Tokyo" }));
  });

  it("forbids members without event.manage", async () => {
    const d = deps();
    const handlers = createEventHandlers(memberOnly(), d);
    expect((await handlers.create(req("POST", { title: "New" }), TEST_ORG)).status).toBe(403);
    expect((await handlers.update(req("PATCH", { capacity: 2 }, { "if-match": "4" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(403);
    expect((await handlers.transition(req("POST", { to: "published" }, { "if-match": "4" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(403);
    expect(d.create).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const handlers = createEventHandlers(allowAll(), deps());
    expect((await handlers.create(req("POST", { title: "x", timezone: "Nope/Nope" }), TEST_ORG)).status).toBe(400);
    expect((await handlers.create(req("POST", "{bad"), TEST_ORG)).status).toBe(400);
    expect((await handlers.update(req("PATCH", { owner: "x" }, { "if-match": "4" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(400);
    expect((await handlers.transition(req("POST", { to: "archived" }, { "if-match": "4" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(400);
  });

  it("requires If-Match for edits and transitions, mapping stale revisions to 409", async () => {
    const stale = deps({ update: vi.fn(async () => { throw new DomainError("event_revision_conflict"); }) });
    const handlers = createEventHandlers(allowAll(), stale);
    expect((await handlers.update(req("PATCH", { capacity: 3 }), TEST_ORG, TEST_OTHER_ID)).status).toBe(428);
    expect((await handlers.update(req("PATCH", { capacity: 3 }, { "if-match": "3" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(409);
    const bad = deps({ transition: vi.fn(async () => { throw new DomainError("invalid_state_transition"); }) });
    expect((await createEventHandlers(allowAll(), bad).transition(req("POST", { to: "live" }, { "if-match": "4" }), TEST_ORG, TEST_OTHER_ID)).status).toBe(409);
  });

  it("passes the cancel reason and returns the new ETag", async () => {
    const d = deps();
    const response = await createEventHandlers(allowAll(), d).transition(req("POST", { to: "cancelled", reason: "Weather" }, { "if-match": "\"4\"" }), TEST_ORG, TEST_OTHER_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe("\"5\"");
    expect(d.transition).toHaveBeenCalledWith(TEST_ORG, TEST_OTHER_ID, TEST_ACCOUNT, "cancelled", 4, "Weather");
  });

  it("returns 404 for missing events and malformed ids", async () => {
    const handlers = createEventHandlers(allowAll(), deps({ get: vi.fn(async () => null), getPublic: vi.fn(async () => null) }));
    expect((await handlers.get(req("GET"), TEST_ORG, TEST_OTHER_ID)).status).toBe(404);
    expect((await handlers.get(req("GET"), TEST_ORG, "../x")).status).toBe(404);
    expect((await handlers.publicGet(anonymous(), TEST_ORG, "missing-slug")).status).toBe(404);
  });

  it("public reads are anonymous; manage listing requires event.manage", async () => {
    const d = deps();
    const handlers = createEventHandlers(denyAll(), d);
    expect((await handlers.publicGet(anonymous(), TEST_ORG, "event")).status).toBe(200);
    expect(d.getPublic).toHaveBeenCalledWith(TEST_ORG, "event", false);
    expect((await handlers.list(anonymous("https://engine.test/api"), TEST_ORG)).status).toBe(200);
    expect(d.listPublic).toHaveBeenCalledWith(TEST_ORG, { member: false });
    expect((await handlers.list(req("GET", undefined, {}, "https://engine.test/api?view=manage"), TEST_ORG)).status).toBe(403);
    expect((await createEventHandlers(allowAll(), d).list(req("GET", undefined, {}, "https://engine.test/api?view=manage"), TEST_ORG)).status).toBe(200);
  });
});
