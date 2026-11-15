import type * as Integrity from "@live-competition-engine/db/voting-integrity";
import { errorResponse, isUuid, json, readJsonObject, requireMember, type Authorizer } from "../../../../../../../lib/http";
import { requireManager, run } from "./handler";

export type IntegrityServices = Pick<typeof Integrity,
  | "getInclusionProof" | "recountVoteWindow" | "voidBallot" | "listBallotVoids" | "listTallySnapshots"
  | "scanVoteAnomalies" | "listAnomalyFlags" | "reviewAnomalyFlag">;

type Scope = { organizationId: string; competitionId: string };

const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });

export function createIntegrityHandlers(authorizer: Authorizer, services: IntegrityServices) {
  const manager = async (request: Request, scope: Scope, windowId: string) => {
    const principal = await requireManager(authorizer, request, scope);
    if (principal instanceof Response) return principal;
    if (!isUuid(windowId)) return errorResponse(404, "vote_window_not_found");
    return principal;
  };

  return {
    /** Any active member holding a receipt may fetch its inclusion proof. */
    async getProof(request: Request, scope: Scope, windowId: string) {
      if (!isUuid(scope.competitionId)) return errorResponse(404, "not_found");
      const principal = await requireMember(authorizer, request, scope.organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(windowId)) return errorResponse(404, "vote_window_not_found");
      const params = new URL(request.url).searchParams;
      const versionParam = params.get("version");
      const version = versionParam === null ? undefined : Number(versionParam);
      if (version !== undefined && !Number.isInteger(version)) return errorResponse(400, "invalid_version");
      return run(async () => json(await services.getInclusionProof(scope.organizationId, scope.competitionId, windowId, params.get("receipt"), version)));
    },

    async postRecount(request: Request, scope: Scope, windowId: string) {
      const principal = await manager(request, scope, windowId);
      if (principal instanceof Response) return principal;
      return run(async () => json(await services.recountVoteWindow(scope.organizationId, scope.competitionId, windowId, principal.accountId)));
    },

    async listVoids(request: Request, scope: Scope, windowId: string) {
      const principal = await manager(request, scope, windowId);
      if (principal instanceof Response) return principal;
      return run(async () => json({ voids: await services.listBallotVoids(scope.organizationId, scope.competitionId, windowId) }));
    },

    async postVoid(request: Request, scope: Scope, windowId: string) {
      const principal = await manager(request, scope, windowId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 2048);
      if (body instanceof Response) return body;
      const target = body.ballotId !== undefined ? { ballotId: body.ballotId } : { receipt: body.receipt };
      return run(async () => json(await services.voidBallot(scope.organizationId, scope.competitionId, windowId, principal.accountId, target, body.reason), 201));
    },

    async listSnapshots(request: Request, scope: Scope, windowId: string) {
      const principal = await manager(request, scope, windowId);
      if (principal instanceof Response) return principal;
      return run(async () => json({ snapshots: await services.listTallySnapshots(scope.organizationId, scope.competitionId, windowId) }));
    },

    async listAnomalies(request: Request, scope: Scope, windowId: string) {
      const principal = await manager(request, scope, windowId);
      if (principal instanceof Response) return principal;
      return run(async () => json({ flags: await services.listAnomalyFlags(scope.organizationId, scope.competitionId, windowId) }));
    },

    async postAnomalyScan(request: Request, scope: Scope, windowId: string) {
      const principal = await manager(request, scope, windowId);
      if (principal instanceof Response) return principal;
      return run(async () => json(await services.scanVoteAnomalies(scope.organizationId, scope.competitionId, windowId, principal.accountId)));
    },

    async patchAnomaly(request: Request, scope: Scope, windowId: string, flagId: string) {
      const principal = await manager(request, scope, windowId);
      if (principal instanceof Response) return principal;
      if (!isUuid(flagId)) return errorResponse(404, "anomaly_flag_not_found");
      const body = await readJsonObject(request, 2048);
      if (body instanceof Response) return body;
      return run(async () => {
        await services.reviewAnomalyFlag(scope.organizationId, scope.competitionId, windowId, flagId, principal.accountId, body.status, body.note);
        return noContent();
      });
    }
  };
}
