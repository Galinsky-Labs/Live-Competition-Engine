import { describe, expect, it, vi } from "vitest";
import { ACCOUNT, COMP, ORG, domainError, fakeAuthorizer, jsonRequest } from "../../../../../../../lib/live-test-helpers";
import { createCaptionHandlers, type CaptionServices } from "./handler";

const CAPTION = "99999999-9999-4999-8999-999999999999";
const caption = { id: CAPTION, kind: "caption" as const, text: "Hello", subtitle: null, createdAt: "" };

function services(overrides: Partial<CaptionServices> = {}): CaptionServices {
  return {
    listActiveCaptions: vi.fn(async () => [caption]),
    setCaption: vi.fn(async () => caption),
    clearCaption: vi.fn(async () => ({ id: CAPTION, cleared: true })),
    ...overrides
  };
}

const producer = fakeAuthorizer(ACCOUNT, ["event.manage"]);

describe("caption handlers", () => {
  it("sets, lists and clears captions for producers", async () => {
    const svc = services();
    const h = createCaptionHandlers(producer, svc);
    const set = await h.set(jsonRequest("POST", { kind: "caption", text: "Hello", idempotencyKey: "idem-123456" }), ORG, COMP);
    expect(set.status).toBe(201);
    expect(svc.setCaption).toHaveBeenCalledWith(ORG, COMP, ACCOUNT, { kind: "caption", text: "Hello", subtitle: undefined, idempotencyKey: "idem-123456" });
    expect((await (await h.list(jsonRequest("GET"), ORG, COMP)).json()).captions).toHaveLength(1);
    expect((await h.clear(jsonRequest("POST", {}), ORG, COMP, CAPTION)).status).toBe(200);
  });

  it("forbids non-producers", async () => {
    const svc = services();
    const h = createCaptionHandlers(fakeAuthorizer(ACCOUNT, ["judging.score", "performance.submit"], "judge"), svc);
    expect((await h.set(jsonRequest("POST", { kind: "caption", text: "x", idempotencyKey: "idem-123456" }), ORG, COMP)).status).toBe(403);
    expect((await h.clear(jsonRequest("POST", {}), ORG, COMP, CAPTION)).status).toBe(403);
    expect(svc.setCaption).not.toHaveBeenCalled();
  });

  it("returns moderation rejections as 400 and unknown captions as 404", async () => {
    const h = createCaptionHandlers(producer, services({
      setCaption: vi.fn(async () => { throw domainError("caption_rejected_link"); }),
      clearCaption: vi.fn(async () => { throw domainError("caption_not_found"); })
    }));
    const rejected = await h.set(jsonRequest("POST", { kind: "caption", text: "evil.com", idempotencyKey: "idem-123456" }), ORG, COMP);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "caption_rejected_link" });
    expect((await h.set(jsonRequest("POST", { kind: "caption", text: "x" }), ORG, COMP)).status).toBe(400);
    expect((await h.clear(jsonRequest("POST", {}), ORG, COMP, CAPTION)).status).toBe(404);
  });
});
