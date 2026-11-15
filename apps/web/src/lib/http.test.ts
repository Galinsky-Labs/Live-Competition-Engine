import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { domainFailure, readJsonObject, requireAction, requireMember } from "./http";

const org = "00000000-0000-4000-8000-000000000001";

describe("shared http helpers", () => {
  it("maps authentication failures to 401/403 and rejects malformed scopes", async () => {
    const forbidden = { authorizeAction: vi.fn(async () => { throw new AuthenticationError("forbidden"); }) };
    const res = await requireAction(forbidden, new Request("https://x"), "tenant.manage", { organizationId: org });
    expect((res as Response).status).toBe(403);
    const missing = { authorize: vi.fn(async () => { throw new AuthenticationError("missing"); }) };
    expect(((await requireMember(missing, new Request("https://x"), org)) as Response).status).toBe(401);
    const res404 = await requireAction(forbidden, new Request("https://x"), "tenant.manage", { organizationId: "bad" });
    expect((res404 as Response).status).toBe(404);
    expect(forbidden.authorizeAction).toHaveBeenCalledTimes(1);
  });
  it("reads only bounded JSON objects", async () => {
    const post = (body: string) => new Request("https://x", { method: "POST", body });
    expect(await readJsonObject(post('{"a":1}'))).toEqual({ a: 1 });
    expect(((await readJsonObject(post("[1]"))) as Response).status).toBe(400);
    expect(((await readJsonObject(post("{"))) as Response).status).toBe(400);
    expect(((await readJsonObject(post(JSON.stringify({ a: "x".repeat(100) })), 10)) as Response).status).toBe(413);
  });
  it("maps domain error codes", () => {
    expect(domainFailure(new DomainError("event_not_found")).status).toBe(404);
    expect(domainFailure(new DomainError("revision_conflict")).status).toBe(409);
    expect(domainFailure(new DomainError("feature_disabled")).status).toBe(403);
    expect(domainFailure(new DomainError("invalid_input")).status).toBe(400);
    expect(() => domainFailure(new Error("boom"))).toThrow("boom");
  });
});
