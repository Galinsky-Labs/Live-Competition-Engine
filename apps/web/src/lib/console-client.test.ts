import { describe, expect, it, vi } from "vitest";
import { ConsoleApiError, createConsoleApi } from "./console-client";

const org = "11111111-1111-4111-8111-111111111111";
const comp = "22222222-2222-4222-8222-222222222222";

describe("console client", () => {
  it("sends the host token as a bearer header, never in the URL", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    const api = createConsoleApi(org, comp, async () => "abc", fetcher as unknown as typeof fetch);
    await api.send("POST", "/applications/bulk-decisions", { decisions: [] });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/organizations/${org}/competitions/${comp}/applications/bulk-decisions`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer abc");
    expect(init.credentials).toBe("omit");
  });

  it("fails closed without a token and maps conflicts to a friendly error", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "application_revision_conflict" }, { status: 409 }));
    await expect(createConsoleApi(org, comp, async () => null, fetcher as unknown as typeof fetch).get("/selection"))
      .rejects.toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
    const error = await createConsoleApi(org, comp, async () => "t", fetcher as unknown as typeof fetch).get("/selection").catch((e: unknown) => e) as ConsoleApiError;
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect(error.code).toBe("application_revision_conflict");
    expect(error.message).toMatch(/changed this first/);
  });

  it("rejects invalid ids and paths", async () => {
    expect(() => createConsoleApi("x", comp, async () => "t")).toThrow();
    await expect(createConsoleApi(org, comp, async () => "t").get("/../../x")).rejects.toThrow(/Invalid console path/);
  });
});
