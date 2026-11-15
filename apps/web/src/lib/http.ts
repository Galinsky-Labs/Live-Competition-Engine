import {
  AuthenticationError,
  AuthenticationService,
  type AuthorizedPrincipal,
  type Principal,
  type ProtectedAction
} from "@live-competition-engine/auth";
import { isUuid } from "@live-competition-engine/domain";

/** Shared response helpers for engine API handlers. Responses are private by default. */
export const noStore = { "cache-control": "private, no-store", vary: "Authorization" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...noStore, ...headers } });
}

export function errorResponse(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, ...extra }, status);
}

export type Authorizer = Pick<AuthenticationService, "authorize" | "authorizeAction">;

export function authFailure(error: unknown): Response {
  if (error instanceof AuthenticationError) {
    return errorResponse(error.code === "forbidden" ? 403 : 401, error.code);
  }
  throw error;
}

/** Authorize a protected action, or return the 401/403 response to send. */
export async function requireAction(
  authorizer: Pick<AuthenticationService, "authorizeAction">,
  request: Request,
  action: ProtectedAction,
  scope: { organizationId?: string; competitionId?: string } = {}
): Promise<AuthorizedPrincipal | Response> {
  if ((scope.organizationId && !isUuid(scope.organizationId)) || (scope.competitionId && !isUuid(scope.competitionId))) {
    return errorResponse(404, "not_found");
  }
  try {
    return await authorizer.authorizeAction(request.headers.get("authorization"), action, scope);
  } catch (error) {
    return authFailure(error);
  }
}

/** Authenticate a session with active membership in the tenant (no role required). */
export async function requireMember(
  authorizer: Pick<AuthenticationService, "authorize">,
  request: Request,
  organizationId: string
): Promise<Principal | Response> {
  if (!isUuid(organizationId)) return errorResponse(404, "not_found");
  try {
    return await authorizer.authorize(request.headers.get("authorization"), organizationId);
  } catch (error) {
    return authFailure(error);
  }
}

/** Optional authentication: anonymous when no Authorization header is present. */
export async function optionalMember(
  authorizer: Pick<AuthenticationService, "authorize">,
  request: Request,
  organizationId: string
): Promise<Principal | null | Response> {
  if (!request.headers.get("authorization")) return null;
  return requireMember(authorizer, request, organizationId);
}

const MAX_JSON_BYTES = 256 * 1024;

/** Parse a bounded JSON object body, or return a 400/413 response. */
export async function readJsonObject(request: Request, maxBytes = MAX_JSON_BYTES): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return errorResponse(413, "payload_too_large");
  let text: string;
  try {
    text = await request.text();
  } catch {
    return errorResponse(400, "invalid_json");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) return errorResponse(413, "payload_too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse(400, "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(400, "invalid_body");
  return body as Record<string, unknown>;
}

/**
 * Map well-known domain/storage errors to HTTP responses. Errors carrying a
 * string `code` property (DomainError) become 4xx; anything else is rethrown.
 */
export function domainFailure(error: unknown, statusByCode: Record<string, number> = {}): Response {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)) {
    const status = statusByCode[code] ??
      (code.endsWith("_not_found") || code === "not_found" ? 404
        : code.includes("conflict") || code.startsWith("invalid_state") ? 409
        : code === "forbidden" ? 403
        : code === "feature_disabled" ? 403
        : code === "rate_limited" ? 429
        : 400);
    return errorResponse(status, code);
  }
  throw error;
}

export { isUuid };
