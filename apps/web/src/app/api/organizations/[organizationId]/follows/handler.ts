import type { FollowRecord, FollowTarget } from "@live-competition-engine/db/follows";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  optionalMember,
  readJsonObject,
  requireMember,
  type Authorizer
} from "../../../../../lib/http";
import { pageParams } from "../../../../../lib/revision";

export interface FollowDeps {
  parseTarget(input: { targetType?: unknown; targetId?: unknown }): FollowTarget;
  follow(organizationId: string, accountId: string, target: FollowTarget): Promise<{ follow: FollowRecord; created: boolean }>;
  unfollow(organizationId: string, accountId: string, target: FollowTarget): Promise<{ removed: boolean }>;
  setConsent(organizationId: string, accountId: string, target: FollowTarget, consent: boolean): Promise<FollowRecord>;
  listMine(organizationId: string, accountId: string, options: { limit?: number; after?: string }): Promise<{ follows: FollowRecord[]; next: string | null }>;
  count(organizationId: string, target: FollowTarget, viewerAccountId: string | null): Promise<number | null>;
}

const queryTarget = (request: Request) => {
  const url = new URL(request.url);
  return { targetType: url.searchParams.get("targetType") ?? undefined, targetId: url.searchParams.get("targetId") ?? undefined };
};

/** All follow writes require an active member; identity comes from the session only. */
export function createFollowHandlers(authorizer: Authorizer, deps: FollowDeps) {
  return {
    async list(request: Request, organizationId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      try {
        return json(await deps.listMine(organizationId, principal.accountId, pageParams(request)));
      } catch (error) {
        return domainFailure(error);
      }
    },

    async follow(request: Request, organizationId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      try {
        const result = await deps.follow(organizationId, principal.accountId, deps.parseTarget(body));
        return json(result.follow, result.created ? 201 : 200);
      } catch (error) {
        return domainFailure(error);
      }
    },

    async unfollow(request: Request, organizationId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      try {
        return json(await deps.unfollow(organizationId, principal.accountId, deps.parseTarget(queryTarget(request))));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** PUT { targetType, targetId, notify: boolean } — explicit notification opt-in/out. */
    async consent(request: Request, organizationId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      if (typeof body.notify !== "boolean") return errorResponse(400, "invalid_consent");
      try {
        return json(await deps.setConsent(organizationId, principal.accountId, deps.parseTarget(body), body.notify));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** Follower COUNT only (lists are private). Members may count members-only targets. */
    async count(request: Request, organizationId: string, anonymousOnly = false): Promise<Response> {
      let viewer: string | null = null;
      if (!anonymousOnly) {
        const principal = await optionalMember(authorizer, request, organizationId);
        if (principal instanceof Response) return principal;
        viewer = principal?.accountId ?? null;
      } else if (!isUuid(organizationId)) {
        return errorResponse(404, "not_found");
      }
      try {
        const target = deps.parseTarget(queryTarget(request));
        const count = await deps.count(organizationId, target, viewer);
        if (count === null) return errorResponse(404, "follow_target_not_found");
        return json({ targetType: target.type, targetId: target.id, followers: count });
      } catch (error) {
        return domainFailure(error);
      }
    }
  };
}
