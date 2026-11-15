import { AuthenticationError } from "@live-competition-engine/auth";

export const SESSION_COOKIE = "lce_session";

/** Domain errors carry an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const errorResponse = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error: code, ...extra }, { status });

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/**
 * Resolves the bearer credential for a request. API clients send `Authorization: Bearer`;
 * the first-party UI sends the HttpOnly session cookie, which is only honoured for
 * safe methods or same-origin mutations (CSRF defence in depth on top of SameSite=Lax).
 */
export function authorizationHeader(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header) return header;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) && !isSameOrigin(request)) return null;
  return `Bearer ${token}`;
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  if (!origin) return fetchSite === "same-origin";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export const clearSessionCookie = (secure: boolean) =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

export async function readJsonObject(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new HttpError(413, "payload_too_large");
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > maxBytes) throw new HttpError(413, "payload_too_large");
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body");
  return body as Record<string, unknown>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUuid(value: unknown, code = "invalid_id"): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new HttpError(400, code);
  return value;
}

/** Maps thrown errors to JSON responses; unknown errors become an opaque 500. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof AuthenticationError) return errorResponse(error.code === "forbidden" ? 403 : 401, error.code);
  if (error instanceof HttpError) return errorResponse(error.status, error.code);
  if (error && typeof error === "object" && "status" in error && "code" in error &&
      typeof (error as { status: unknown }).status === "number" && typeof (error as { code: unknown }).code === "string") {
    const status = (error as { status: number }).status;
    const extra: Record<string, unknown> = {};
    for (const key of ["issues", "blockers"] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (Array.isArray(value)) extra[key] = value.filter(v => typeof v === "string").slice(0, 20);
    }
    if (status >= 400 && status < 500) return errorResponse(status, (error as { code: string }).code, extra);
  }
  if (error && typeof error === "object" && "issues" in error) return errorResponse(400, "invalid_request");
  console.error(error);
  return errorResponse(500, "internal_error");
}

export function route<A extends unknown[]>(fn: (request: Request, ...args: A) => Promise<Response>) {
  return async (request: Request, ...args: A): Promise<Response> => {
    try {
      return await fn(request, ...args);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
