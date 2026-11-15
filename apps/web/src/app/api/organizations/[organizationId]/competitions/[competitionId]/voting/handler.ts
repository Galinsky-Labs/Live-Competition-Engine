import type * as Voting from "@live-competition-engine/db/voting";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  requireMember,
  type Authorizer
} from "../../../../../../../lib/http";

export type VotingServices = Pick<typeof Voting,
  | "createVoteWindow" | "transitionVoteWindow" | "closeVoteWindow" | "listVoteWindows"
  | "getVoteWindow" | "castBallot" | "getVoteResults">;

type Scope = { organizationId: string; competitionId: string };

const statusByCode = { voter_not_eligible: 403, ballot_voided: 403 };

export async function run(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return domainFailure(error, statusByCode);
  }
}

/** event.manage holders are managers; everyone else must be an active member. */
export async function resolveViewer(authorizer: Authorizer, request: Request, scope: Scope) {
  if (!isUuid(scope.organizationId) || !isUuid(scope.competitionId)) return errorResponse(404, "not_found");
  const manager = await requireAction(authorizer, request, "event.manage", scope);
  if (!(manager instanceof Response)) return { accountId: manager.accountId, isManager: true };
  if (manager.status === 401) return manager;
  const member = await requireMember(authorizer, request, scope.organizationId);
  if (member instanceof Response) return member;
  return { accountId: member.accountId, isManager: false };
}

export const requireManager = (authorizer: Authorizer, request: Request, scope: Scope) =>
  requireAction(authorizer, request, "event.manage", scope);

export function createVotingHandlers(authorizer: Authorizer, services: VotingServices) {
  return {
    async listWindows(request: Request, scope: Scope) {
      const who = await resolveViewer(authorizer, request, scope);
      if (who instanceof Response) return who;
      return run(async () => json({ windows: await services.listVoteWindows(scope.organizationId, scope.competitionId, { isManager: who.isManager }) }));
    },

    async createWindow(request: Request, scope: Scope) {
      const principal = await requireManager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 64 * 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await services.createVoteWindow(scope.organizationId, scope.competitionId, principal.accountId, body), 201));
    },

    async getWindow(request: Request, scope: Scope, windowId: string) {
      const who = await resolveViewer(authorizer, request, scope);
      if (who instanceof Response) return who;
      if (!isUuid(windowId)) return errorResponse(404, "vote_window_not_found");
      return run(async () => json(await services.getVoteWindow(scope.organizationId, scope.competitionId, windowId, who)));
    },

    async patchWindow(request: Request, scope: Scope, windowId: string) {
      const principal = await requireManager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(windowId)) return errorResponse(404, "vote_window_not_found");
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await services.transitionVoteWindow(
        scope.organizationId, scope.competitionId, windowId, principal.accountId, body.action, body.expectedRevision)));
    },

    async closeWindow(request: Request, scope: Scope, windowId: string) {
      const principal = await requireManager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(windowId)) return errorResponse(404, "vote_window_not_found");
      return run(async () => json(await services.closeVoteWindow(scope.organizationId, scope.competitionId, windowId, principal.accountId)));
    },

    async castBallot(request: Request, scope: Scope, windowId: string) {
      if (!isUuid(scope.competitionId)) return errorResponse(404, "not_found");
      const principal = await requireMember(authorizer, request, scope.organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(windowId)) return errorResponse(404, "vote_window_not_found");
      const body = await readJsonObject(request, 16 * 1024);
      if (body instanceof Response) return body;
      const idempotencyKey = request.headers.get("idempotency-key") ?? body.idempotencyKey;
      return run(async () => {
        const receipt = await services.castBallot(scope.organizationId, scope.competitionId, windowId,
          { accountId: principal.accountId, sessionId: principal.sessionId }, body.choice, idempotencyKey);
        return json(receipt, receipt.replayed ? 200 : 201);
      });
    },

    async getResults(request: Request, scope: Scope, windowId: string) {
      const who = await resolveViewer(authorizer, request, scope);
      if (who instanceof Response) return who;
      if (!isUuid(windowId)) return errorResponse(404, "vote_window_not_found");
      return run(async () => json(await services.getVoteResults(scope.organizationId, scope.competitionId, windowId, { isManager: who.isManager })));
    }
  };
}
