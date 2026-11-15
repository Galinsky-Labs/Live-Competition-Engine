import type { AuthenticationService, Principal, ProtectedAction } from "@live-competition-engine/auth";
import { DomainError } from "@live-competition-engine/domain";
import { domainFailure, errorResponse, isUuid, json, readJsonObject, requireAction, requireMember } from "./http";

/**
 * Small endpoint builder for the competition-scoped modules (LC-17..LC-21).
 * Order of checks: path ids (404) → authentication/authorization (401/403) → body (400/413)
 * → service call, whose DomainErrors map through `domainFailure`. Identity always comes
 * from the authenticated principal, never from the body.
 */
export type EndpointAuthorizer = Pick<AuthenticationService, "authorize" | "authorizeAction">;
export type Access = "member" | ProtectedAction;
export type ScopeParams = { organizationId: string; competitionId?: string } & Record<string, string>;

export interface EndpointContext<P extends ScopeParams> {
  request: Request;
  params: P;
  principal: Principal;
  body: Record<string, unknown>;
  url: URL;
}

/** Codes whose default mapping (400/404/409) is not the right HTTP meaning. */
const statusByCode: Record<string, number> = {
  invitation_email_mismatch: 403,
  judge_recused: 403,
  judge_not_verified: 403,
  judge_inactive: 403,
  self_approval_forbidden: 403,
  invitation_expired: 410,
  invitation_revoked: 410
};

export function endpoint<P extends ScopeParams>(
  authorizer: EndpointAuthorizer,
  access: Access,
  run: (context: EndpointContext<P>) => Promise<unknown>,
  options: { body?: boolean; status?: number | ((result: unknown) => number) } = {}
) {
  return async (request: Request, params: P): Promise<Response> => {
    for (const value of Object.values(params)) if (!isUuid(value)) return errorResponse(404, "not_found");
    const principal = access === "member"
      ? await requireMember(authorizer, request, params.organizationId)
      : await requireAction(authorizer, request, access, {
        organizationId: params.organizationId,
        ...(params.competitionId ? { competitionId: params.competitionId } : {})
      });
    if (principal instanceof Response) return principal;
    let body: Record<string, unknown> = {};
    if (options.body) {
      const parsed = await readJsonObject(request, 128 * 1024);
      if (parsed instanceof Response) return parsed;
      body = parsed;
    }
    try {
      const result = await run({ request, params, principal, body, url: new URL(request.url) });
      if (result instanceof Response) return result;
      const status = typeof options.status === "function" ? options.status(result) : options.status ?? 200;
      return json(result, status);
    } catch (error) {
      return domainFailure(error, statusByCode);
    }
  };
}

/** Adapt an endpoint to a Next.js route export. */
export function route<P extends ScopeParams>(handler: (request: Request, params: P) => Promise<Response>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => handler(request, await context.params);
}

export function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d{1,6}$/.test(raw)) throw new DomainError("invalid_query");
  return Number(raw);
}

export function uuidParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!isUuid(raw)) throw new DomainError("invalid_query");
  return raw;
}

export { errorResponse, isUuid };
