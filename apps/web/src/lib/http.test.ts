import { describe, expect, it } from "vitest";
import { AuthenticationError } from "@live-competition-engine/auth";
import { authorizationHeader, HttpError, readCookie, readJsonObject, requireUuid, sessionCookie, toErrorResponse } from "./http";

const req = (method: string, headers: Record<string, string>, body?: string) =>
  new Request("http://app.test/api/x", { method, headers, ...(body ? { body } : {}) });

describe("cookie-backed authorization", () => {
  it("prefers explicit bearer headers", () => {
    expect(authorizationHeader(req("POST", { authorization: "Bearer abc", cookie: "lce_session=zzz" }))).toBe("Bearer abc");
  });
  it("uses the session cookie for safe methods", () => {
    expect(authorizationHeader(req("GET", { cookie: "a=1; lce_session=tok" }))).toBe("Bearer tok");
  });
  it("accepts cookie mutations only from the same origin", () => {
    expect(authorizationHeader(req("POST", { cookie: "lce_session=tok", origin: "http://app.test", host: "app.test" }))).toBe("Bearer tok");
    expect(authorizationHeader(req("POST", { cookie: "lce_session=tok", origin: "https://evil.test", host: "app.test" }))).toBeNull();
    expect(authorizationHeader(req("POST", { cookie: "lce_session=tok", host: "app.test" }))).toBeNull();
    expect(authorizationHeader(req("POST", { cookie: "lce_session=tok", origin: "http://app.test", host: "app.test", "sec-fetch-site": "cross-site" }))).toBeNull();
  });
  it("parses cookies and builds hardened session cookies", () => {
    expect(readCookie(req("GET", { cookie: "x=1;  lce_session=a%2Bb " }), "lce_session")).toBe("a+b");
    const cookie = sessionCookie("t", new Date(Date.now() + 60_000), true);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
  });
});

describe("request helpers", () => {
  it("rejects malformed and oversize JSON", async () => {
    await expect(readJsonObject(req("POST", {}, "nope"))).rejects.toMatchObject({ code: "invalid_json" });
    await expect(readJsonObject(req("POST", {}, "[1]"))).rejects.toMatchObject({ code: "invalid_body" });
    await expect(readJsonObject(req("POST", {}, JSON.stringify({ a: "x".repeat(100) })), 10)).rejects.toMatchObject({ code: "payload_too_large" });
    expect(await readJsonObject(req("POST", {}, "{\"a\":1}"))).toEqual({ a: 1 });
  });
  it("validates ids and maps errors to stable responses", async () => {
    expect(() => requireUuid("x")).toThrow(HttpError);
    expect(toErrorResponse(new AuthenticationError("forbidden")).status).toBe(403);
    expect(toErrorResponse(new AuthenticationError("missing")).status).toBe(401);
    const domain = Object.assign(new Error("x"), { status: 409, code: "conflict" });
    const response = toErrorResponse(domain);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict" });
  });
});
