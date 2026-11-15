import type * as Scoring from "@live-competition-engine/db/scoring";
import { endpoint, uuidParam, type EndpointAuthorizer } from "../../../../../../../lib/competition-endpoint";

export type ScoringService = Pick<typeof Scoring,
  | "createRubric" | "listRubrics" | "getActiveRubric" | "activateRubric" | "getOwnScoreSheet" | "saveScoreSheet"
  | "requestScoreCorrection" | "listCorrections" | "decideCorrection" | "getStandings">;

type Comp = { organizationId: string; competitionId: string };
type Perf = Comp & { roundId: string; performanceId: string };

/**
 * LC-20. Producers (`event.manage`) manage rubric versions, decide corrections and read standings.
 * Judges (`judging.score` for the competition) read/save their own sheets and request corrections.
 */
export function createScoringHandlers(auth: EndpointAuthorizer, service: ScoringService) {
  return {
    listRubrics: endpoint<Comp>(auth, "event.manage", async ({ params }) => ({ items: await service.listRubrics(params.organizationId, params.competitionId) })),
    createRubric: endpoint<Comp>(auth, "event.manage", ({ params, principal, body }) =>
      service.createRubric(params.organizationId, params.competitionId, principal.accountId, body.definition), { body: true, status: 201 }),
    activeRubric: endpoint<Comp>(auth, "judging.score", ({ params }) => service.getActiveRubric(params.organizationId, params.competitionId)),
    activateRubric: endpoint<Comp & { rubricId: string }>(auth, "event.manage", ({ params, principal }) =>
      service.activateRubric(params.organizationId, params.competitionId, principal.accountId, params.rubricId)),
    getSheet: endpoint<Perf>(auth, "judging.score", ({ params, principal }) =>
      service.getOwnScoreSheet(params.organizationId, params.competitionId, principal.accountId, params.roundId, params.performanceId)),
    saveSheet: endpoint<Perf>(auth, "judging.score", ({ params, principal, body }) =>
      service.saveScoreSheet(params.organizationId, params.competitionId, principal.accountId, params.roundId, params.performanceId,
        { values: body.values, submit: body.submit, expectedRevision: body.expectedRevision }),
    { body: true }),
    requestCorrection: endpoint<Comp>(auth, "judging.score", ({ params, principal, body }) =>
      service.requestScoreCorrection(params.organizationId, params.competitionId, principal.accountId,
        { sheetId: body.sheetId, values: body.values, reason: body.reason }),
    { body: true, status: 201 }),
    listCorrections: endpoint<Comp>(auth, "event.manage", async ({ params, url }) => ({
      items: await service.listCorrections(params.organizationId, params.competitionId, { status: url.searchParams.get("status") ?? undefined })
    })),
    decideCorrection: endpoint<Comp & { correctionId: string }>(auth, "event.manage", ({ params, principal, body }) =>
      service.decideCorrection(params.organizationId, params.competitionId, principal.accountId, params.correctionId,
        { decision: body.decision, reason: body.reason, expectedRevision: body.expectedRevision }),
    { body: true }),
    standings: endpoint<Comp>(auth, "event.manage", ({ params, url }) =>
      service.getStandings(params.organizationId, params.competitionId, { roundId: uuidParam(url, "roundId") }))
  };
}
