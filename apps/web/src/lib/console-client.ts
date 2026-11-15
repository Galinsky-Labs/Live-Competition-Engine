/**
 * Browser client for the producer/judge consoles (LC-17..LC-21). The host page supplies a
 * session token callback (`window.lceConsoleAuthorization`), mirroring the media library:
 * tokens stay in the Authorization header and are never stored, logged or put in URLs.
 */
export type Authorization = () => Promise<string | null>;

declare global {
  interface Window { lceConsoleAuthorization?: Authorization; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token callback installed by the embedding host, or a callback that reports "signed out". */
export function hostAuthorization(): Authorization {
  return async () => (typeof window !== "undefined" && typeof window.lceConsoleAuthorization === "function"
    ? window.lceConsoleAuthorization() : null);
}

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(describe(status, code));
    this.status = status;
    this.code = code;
  }
}

function describe(status: number, code: string): string {
  if (status === 401) return "Sign in to use this console.";
  if (status === 403) return code === "feature_disabled" ? "This capability is not enabled for this event." : "Your account cannot do this for this event.";
  if (status === 404) return "That item no longer exists or is not available to you.";
  if (status === 409) return code.includes("conflict")
    ? "Someone else changed this first. The view was refreshed; review it and try again."
    : "That change is not allowed in the current state.";
  if (status === 400 || status === 413) return `The request was not accepted (${code.replace(/_/g, " ")}).`;
  return "The service is unavailable. Please try again.";
}

export interface ConsoleApi {
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

export function createConsoleApi(organizationId: string, competitionId: string, authorization: Authorization, fetcher: typeof fetch = fetch): ConsoleApi {
  if (!UUID.test(organizationId) || !UUID.test(competitionId)) throw new Error("Select a valid event.");
  const root = `/api/organizations/${organizationId}/competitions/${competitionId}`;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!/^(\/[A-Za-z0-9_-]+)*(\?[A-Za-z0-9_=&%.-]*)?$/.test(path)) throw new Error("Invalid console path.");
    const token = await authorization();
    if (!token) throw new ConsoleApiError(401, "missing");
    const headers = new Headers({ authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` });
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await fetcher(root + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store", credentials: "omit", redirect: "error"
    });
    if (!response.ok) {
      let code = "error";
      try { code = String(((await response.json()) as { error?: unknown }).error ?? "error"); } catch { /* non-JSON error */ }
      throw new ConsoleApiError(response.status, /^[a-z0-9_]{1,80}$/.test(code) ? code : "error");
    }
    return (await response.json()) as T;
  }
  return {
    get: path => call("GET", path),
    send: (method, path, body) => call(method, path, body)
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
