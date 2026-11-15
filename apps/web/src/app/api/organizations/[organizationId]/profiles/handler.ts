import type { ProfilePatch, ProfileView } from "@live-competition-engine/profiles";
import type { ProfileSummary } from "@live-competition-engine/db/profiles";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  optionalMember,
  readJsonObject,
  requireAction,
  requireMember,
  type Authorizer
} from "../../../../../lib/http";
import { etag, pageParams, parseIfMatch } from "../../../../../lib/revision";

export interface ProfileDeps {
  read(organizationId: string, profileId: string, viewerAccountId: string | null): Promise<(ProfileView & { hidden: boolean }) | null>;
  list(organizationId: string, viewerAccountId: string | null, options: { limit?: number; after?: string }): Promise<{ profiles: ProfileSummary[]; next: string | null }>;
  parsePatch(body: Record<string, unknown>): ProfilePatch;
  edit(organizationId: string, profileId: string, accountId: string, patch: ProfilePatch, expectedRevision: number | null): Promise<ProfileView>;
  moderate(organizationId: string, profileId: string, actorAccountId: string, input: { hidden: boolean; reason?: string }): Promise<{ id: string; hidden: boolean }>;
  linkParticipant(organizationId: string, participantId: string, accountId: string | null, actorAccountId: string): Promise<{ participantId: string; accountId: string | null }>;
  /** LC-08 `public_profiles` flag for anonymous (internet) exposure. */
  publicEnabled(organizationId: string): Promise<boolean>;
}

const notFound = () => errorResponse(404, "profile_not_found");

export function createProfileHandlers(authorizer: Authorizer, deps: ProfileDeps) {
  return {
    /** GET tenant list: anonymous sees public profiles; members also see members-only. */
    async list(request: Request, organizationId: string): Promise<Response> {
      const viewer = await optionalMember(authorizer, request, organizationId);
      if (viewer instanceof Response) return viewer;
      if (!viewer && !(await deps.publicEnabled(organizationId))) return errorResponse(403, "feature_disabled");
      try {
        return json(await deps.list(organizationId, viewer?.accountId ?? null, pageParams(request)));
      } catch (error) {
        return domainFailure(error);
      }
    },

    async get(request: Request, organizationId: string, profileId: string): Promise<Response> {
      const viewer = await optionalMember(authorizer, request, organizationId);
      if (viewer instanceof Response) return viewer;
      if (!isUuid(profileId)) return notFound();
      if (!viewer && !(await deps.publicEnabled(organizationId))) return notFound();
      const view = await deps.read(organizationId, profileId, viewer?.accountId ?? null);
      return view ? json(view, 200, etag(view.revision)) : notFound();
    },

    /** PUT owner-only create (no If-Match) or update (If-Match: "<revision>"). */
    async put(request: Request, organizationId: string, profileId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(profileId)) return notFound();
      const expected = parseIfMatch(request);
      if (expected === "invalid") return errorResponse(400, "invalid_if_match");
      const body = await readJsonObject(request, 16 * 1024);
      if (body instanceof Response) return body;
      try {
        const view = await deps.edit(organizationId, profileId, principal.accountId, deps.parsePatch(body), expected);
        return json(view, expected === null ? 201 : 200, etag(view.revision));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** POST moderation: tenant.manage hides/restores a profile. */
    async moderate(request: Request, organizationId: string, profileId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
      if (principal instanceof Response) return principal;
      if (!isUuid(profileId)) return notFound();
      const body = await readJsonObject(request, 4 * 1024);
      if (body instanceof Response) return body;
      if (typeof body.hidden !== "boolean" || (body.reason !== undefined && typeof body.reason !== "string")) {
        return errorResponse(400, "invalid_moderation");
      }
      try {
        return json(await deps.moderate(organizationId, profileId, principal.accountId, {
          hidden: body.hidden, ...(typeof body.reason === "string" ? { reason: body.reason } : {})
        }));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** PUT participant -> account link (tenant.manage). Body: { accountId: uuid | null }. */
    async linkParticipant(request: Request, organizationId: string, participantId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
      if (principal instanceof Response) return principal;
      if (!isUuid(participantId)) return errorResponse(404, "participant_not_found");
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      if (body.accountId !== null && !isUuid(body.accountId)) return errorResponse(400, "invalid_account");
      try {
        return json(await deps.linkParticipant(organizationId, participantId, body.accountId as string | null, principal.accountId));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** Anonymous public projection; never authenticates, never shows members/private. */
    async publicGet(_request: Request, organizationId: string, profileId: string): Promise<Response> {
      if (!isUuid(organizationId) || !isUuid(profileId)) return notFound();
      if (!(await deps.publicEnabled(organizationId))) return notFound();
      const view = await deps.read(organizationId, profileId, null);
      if (!view) return notFound();
      const { hidden: _hidden, ...publicView } = view;
      return json(publicView, 200, etag(view.revision));
    },

    async publicList(request: Request, organizationId: string): Promise<Response> {
      if (!isUuid(organizationId)) return errorResponse(404, "not_found");
      if (!(await deps.publicEnabled(organizationId))) return errorResponse(403, "feature_disabled");
      try {
        return json(await deps.list(organizationId, null, pageParams(request)));
      } catch (error) {
        return domainFailure(error);
      }
    }
  };
}
