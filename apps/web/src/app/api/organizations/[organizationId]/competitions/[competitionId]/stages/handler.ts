import type { AdvancementDecision, StageRecord } from "@live-competition-engine/db/stages";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  type Authorizer
} from "../../../../../../../lib/http";
import { etag, parseIfMatch } from "../../../../../../../lib/revision";

export interface StageDeps {
  list(organizationId: string, competitionId: string): Promise<StageRecord[]>;
  create(organizationId: string, competitionId: string, actorAccountId: string, body: Record<string, unknown>): Promise<StageRecord>;
  update(organizationId: string, competitionId: string, stageId: string, actorAccountId: string, body: Record<string, unknown>, expectedRevision: number): Promise<StageRecord>;
  reorder(organizationId: string, competitionId: string, actorAccountId: string, order: unknown): Promise<StageRecord[]>;
  decide(organizationId: string, competitionId: string, stageId: string, actorAccountId: string, input: { idempotencyKey: string; selection?: string[] }): Promise<AdvancementDecision>;
  getDecision(organizationId: string, competitionId: string, stageId: string): Promise<AdvancementDecision | null>;
}

/** Stage builder handlers: all require event.manage scoped to the competition. */
export function createStageHandlers(authorizer: Authorizer, deps: StageDeps) {
  const manage = (request: Request, organizationId: string, competitionId: string) =>
    requireAction(authorizer, request, "event.manage", { organizationId, competitionId });

  return {
    async list(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      return json({ stages: await deps.list(organizationId, competitionId) });
    },

    async create(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      try {
        const stage = await deps.create(organizationId, competitionId, principal.accountId, body);
        return json(stage, 201, etag(stage.revision));
      } catch (error) {
        return domainFailure(error);
      }
    },

    async update(request: Request, organizationId: string, competitionId: string, stageId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      if (!isUuid(stageId)) return errorResponse(404, "stage_not_found");
      const expected = parseIfMatch(request);
      if (expected === "invalid") return errorResponse(400, "invalid_if_match");
      if (expected === null) return errorResponse(428, "if_match_required");
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      try {
        const stage = await deps.update(organizationId, competitionId, stageId, principal.accountId, body, expected);
        return json(stage, 200, etag(stage.revision));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** PUT { stageIds: [...] } — a permutation of every stage of the event. */
    async reorder(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 64 * 1024);
      if (body instanceof Response) return body;
      try {
        return json({ stages: await deps.reorder(organizationId, competitionId, principal.accountId, body.stageIds) });
      } catch (error) {
        return domainFailure(error);
      }
    },

    async getDecision(request: Request, organizationId: string, competitionId: string, stageId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const decision = await deps.getDecision(organizationId, competitionId, stageId);
      return decision ? json(decision) : errorResponse(404, "stage_advancement_not_found");
    },

    /** POST { idempotencyKey, selection? } — record the stage's advancement decision. */
    async decide(request: Request, organizationId: string, competitionId: string, stageId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      if (!isUuid(stageId)) return errorResponse(404, "stage_not_found");
      const body = await readJsonObject(request, 256 * 1024);
      if (body instanceof Response) return body;
      const idempotencyKey = body.idempotencyKey ?? request.headers.get("idempotency-key");
      if (typeof idempotencyKey !== "string") return errorResponse(400, "invalid_idempotency_key");
      if (body.selection !== undefined && (!Array.isArray(body.selection) || body.selection.length > 10_000 || !body.selection.every(isUuid))) {
        return errorResponse(400, "invalid_advancement_selection");
      }
      try {
        const decision = await deps.decide(organizationId, competitionId, stageId, principal.accountId, {
          idempotencyKey, ...(body.selection ? { selection: body.selection as string[] } : {})
        });
        return json(decision, decision.replayed ? 200 : 201);
      } catch (error) {
        return domainFailure(error);
      }
    }
  };
}
