import { createHash } from "node:crypto";
import type { AuthorizedPrincipal } from "@live-competition-engine/auth";
import { domainFailure, errorResponse, requireAction, type Authorizer } from "./http";

/**
 * Shared HTTP helpers for the live-production modules (streams, backstage,
 * timers, control room, broadcast). Kept separate from lib/http.ts (coordinator-owned).
 */
export const liveStatusByCode: Record<string, number> = {
  provider_not_configured: 503,
  provider_unavailable: 502,
  provider_rejected_credentials: 502,
  provider_invalid_response: 502,
  provider_stream_not_found: 502,
  idempotency_conflict: 409,
  stream_provider_mismatch: 409
};

/** Run a service call, mapping DomainError codes to HTTP responses. */
export async function runService(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    return domainFailure(error, liveStatusByCode);
  }
}

/** Authorize `event.manage` scoped to the competition (producers and tenant operators). */
export function requireProducer(authorizer: Pick<Authorizer, "authorizeAction">, request: Request, organizationId: string, competitionId: string) {
  return requireAction(authorizer, request, "event.manage", { organizationId, competitionId });
}

export type LiveRole = "producer" | "judge" | "performer";

/**
 * Resolve the most privileged live-production role the caller holds for this
 * competition: producer (event.manage) > judge (judging.score) > performer
 * (performance.submit). Returns the 401/403/404 response when none applies.
 */
export async function resolveLiveRole(
  authorizer: Pick<Authorizer, "authorizeAction">,
  request: Request,
  organizationId: string,
  competitionId: string
): Promise<{ role: LiveRole; principal: AuthorizedPrincipal } | Response> {
  let last: Response | null = null;
  for (const [action, role] of [["event.manage", "producer"], ["judging.score", "judge"], ["performance.submit", "performer"]] as const) {
    const result = await requireAction(authorizer, request, action, { organizationId, competitionId });
    if (!(result instanceof Response)) return { role, principal: result };
    if (result.status !== 403) return result; // 401/404: no point trying other roles
    last = result;
  }
  return last ?? errorResponse(403, "forbidden");
}

/** Optional `If-Match`-style revision from a JSON body field. */
export function intField(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * Public, cacheable JSON with a strong ETag over `stableBody` (content that does not
 * change every request) and `If-None-Match` → 304 support. `volatile` fields such as
 * `serverNow` are merged into the 200 body but excluded from the ETag.
 */
export function publicJson(
  request: Request,
  stableBody: Record<string, unknown>,
  volatile: Record<string, unknown> = {},
  options: { maxAgeSeconds?: number; headers?: Record<string, string> } = {}
): Response {
  const etag = `"${createHash("sha256").update(JSON.stringify(stableBody)).digest("base64url").slice(0, 32)}"`;
  const headers = {
    "cache-control": `public, max-age=${options.maxAgeSeconds ?? 1}, stale-while-revalidate=2`,
    etag,
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "etag, x-server-now",
    ...options.headers
  };
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").map(tag => tag.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json({ ...stableBody, ...volatile }, { status: 200, headers });
}

export function publicNotFound(): Response {
  return Response.json({ error: "not_found" }, {
    status: 404,
    headers: { "cache-control": "public, max-age=5", "access-control-allow-origin": "*" }
  });
}
