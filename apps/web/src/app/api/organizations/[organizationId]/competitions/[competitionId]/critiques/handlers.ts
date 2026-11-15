import type * as Critiques from "@live-competition-engine/db/critiques";
import { domainFailure, json } from "../../../../../../../lib/http";
import { endpoint, errorResponse, isUuid, type EndpointAuthorizer } from "../../../../../../../lib/competition-endpoint";

export type CritiquesService = Pick<typeof Critiques,
  | "saveCritiqueDraft" | "submitCritique" | "withdrawCritique" | "listJudgeCritiques" | "listCritiquesForModeration" | "moderateCritique"
  | "retractCritique" | "listEntrantCritiques" | "listPublicCritiques" | "fileAppeal" | "withdrawAppeal" | "resolveAppeal" | "listAppeals">;

type Comp = { organizationId: string; competitionId: string };
type Crit = Comp & { critiqueId: string };
type Appeal = Comp & { appealId: string };

/**
 * LC-21 (feature `critiques`, enforced in the service). Judges (`judging.score`) write critiques;
 * producers (`event.manage`) moderate, retract and resolve appeals; entrants (members) read their own
 * critiques and file/withdraw appeals; the public reads published public critiques.
 */
export function createCritiqueHandlers(auth: EndpointAuthorizer, service: CritiquesService) {
  return {
    saveDraft: endpoint<Comp & { roundId: string; performanceId: string }>(auth, "judging.score", ({ params, principal, body }) =>
      service.saveCritiqueDraft(params.organizationId, params.competitionId, principal.accountId, params.roundId, params.performanceId,
        { body: body.body, visibility: body.visibility, expectedRevision: body.expectedRevision }),
    { body: true }),
    judgeList: endpoint<Comp>(auth, "judging.score", async ({ params, principal }) => ({
      items: await service.listJudgeCritiques(params.organizationId, params.competitionId, principal.accountId)
    })),
    submit: endpoint<Crit>(auth, "judging.score", ({ params, principal, body }) =>
      service.submitCritique(params.organizationId, params.competitionId, principal.accountId, params.critiqueId, body.expectedRevision), { body: true }),
    withdraw: endpoint<Crit>(auth, "judging.score", ({ params, principal, body }) =>
      service.withdrawCritique(params.organizationId, params.competitionId, principal.accountId, params.critiqueId, body.expectedRevision), { body: true }),
    queue: endpoint<Comp>(auth, "event.manage", async ({ params, url }) => ({
      items: await service.listCritiquesForModeration(params.organizationId, params.competitionId, { status: url.searchParams.get("status") ?? undefined })
    })),
    moderate: endpoint<Crit>(auth, "event.manage", ({ params, principal, body }) =>
      service.moderateCritique(params.organizationId, params.competitionId, principal.accountId, params.critiqueId,
        { decision: body.decision, reason: body.reason, expectedRevision: body.expectedRevision }),
    { body: true }),
    retract: endpoint<Crit>(auth, "event.manage", ({ params, principal, body }) =>
      service.retractCritique(params.organizationId, params.competitionId, principal.accountId, params.critiqueId,
        { reason: body.reason, expectedRevision: body.expectedRevision }),
    { body: true }),
    mine: endpoint<Comp>(auth, "member", async ({ params, principal }) => ({
      items: await service.listEntrantCritiques(params.organizationId, params.competitionId, principal.accountId)
    })),
    fileAppeal: endpoint<Crit>(auth, "member", ({ params, principal, body }) =>
      service.fileAppeal(params.organizationId, params.competitionId, principal.accountId, params.critiqueId, { kind: body.kind, body: body.body }),
    { body: true, status: 201 }),
    withdrawAppeal: endpoint<Appeal>(auth, "member", ({ params, principal, body }) =>
      service.withdrawAppeal(params.organizationId, params.competitionId, principal.accountId, params.appealId, body.expectedRevision), { body: true }),
    appeals: endpoint<Comp>(auth, "event.manage", async ({ params, url }) => ({
      items: await service.listAppeals(params.organizationId, params.competitionId, { status: url.searchParams.get("status") ?? undefined })
    })),
    resolveAppeal: endpoint<Appeal>(auth, "event.manage", ({ params, principal, body }) =>
      service.resolveAppeal(params.organizationId, params.competitionId, principal.accountId, params.appealId,
        { status: body.status, reason: body.reason, retract: body.retract, expectedRevision: body.expectedRevision }),
    { body: true })
  };
}

/** Anonymous read of published public critiques. Returns only the explicit public projection. */
export function createPublicCritiquesHandler(service: Pick<CritiquesService, "listPublicCritiques">) {
  return async (_request: Request, params: Comp): Promise<Response> => {
    if (!isUuid(params.organizationId) || !isUuid(params.competitionId)) return errorResponse(404, "not_found");
    try {
      const items = await service.listPublicCritiques(params.organizationId, params.competitionId);
      return json({ items }, 200, { "cache-control": "public, max-age=30", vary: "Accept-Encoding" });
    } catch (error) {
      // A disabled feature looks like an absent resource to anonymous callers.
      if ((error as { code?: string }).code === "feature_disabled") return errorResponse(404, "not_found");
      return domainFailure(error);
    }
  };
}
