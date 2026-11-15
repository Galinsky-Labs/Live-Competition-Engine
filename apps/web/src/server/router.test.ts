import { describe, expect, it } from "vitest";
import { createRouter } from "./router";

const org = "11111111-1111-4111-8111-111111111111";
const ev = "22222222-2222-4222-8222-222222222222";
const dispatch = createRouter([
  { method: "GET", pattern: "", handler: async () => Response.json({ list: true }) },
  { method: "GET", pattern: "templates", handler: async () => Response.json({ templates: true }) },
  { method: "GET", pattern: ":eventId", handler: async ctx => Response.json({ id: ctx.params.eventId }) },
  { method: "POST", pattern: ":eventId/publish", handler: async ctx => Response.json(await ctx.body()) },
  { method: "GET", pattern: ":eventId/boom", handler: async () => { throw Object.assign(new Error("x"), { status: 409, code: "revision_conflict" }); } }
]);
const req = (method: string, body?: unknown) => new Request("http://t/x", { method, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("event API router", () => {
  it("matches static and uuid segments", async () => {
    expect(await (await dispatch(req("GET"), org, [])).json()).toEqual({ list: true });
    expect(await (await dispatch(req("GET"), org, ["templates"])).json()).toEqual({ templates: true });
    expect(await (await dispatch(req("GET"), org, [ev])).json()).toEqual({ id: ev });
  });
  it("rejects non-uuid ids, unknown paths and wrong methods", async () => {
    expect((await dispatch(req("GET"), org, ["not-a-uuid"])).status).toBe(404);
    expect((await dispatch(req("GET"), "bad-org", [])).status).toBe(400);
    expect((await dispatch(req("DELETE"), org, [ev])).status).toBe(405);
    expect((await dispatch(req("GET"), org, [ev, "nope"])).status).toBe(404);
  });
  it("parses bodies and maps domain errors", async () => {
    expect(await (await dispatch(req("POST", { expectedRevision: 3 }), org, [ev, "publish"])).json()).toEqual({ expectedRevision: 3 });
    const failed = await dispatch(req("GET"), org, [ev, "boom"]);
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ error: "revision_conflict" });
  });
});
