import type * as Selection from "@live-competition-engine/db/selection";
import { endpoint, type EndpointAuthorizer } from "../../../../../../../lib/competition-endpoint";

export type SelectionService = Pick<typeof Selection,
  "getSelectionSummary" | "getRoundLineup" | "setRoundLineup" | "listLineupHistory" | "getRoundPanel" | "assignJudgeToRound" | "removeJudgeFromRound">;

type Comp = { organizationId: string; competitionId: string };
type Round = Comp & { roundId: string };

/** LC-18 producer console API. Every endpoint requires `event.manage` for the competition. */
export function createSelectionHandlers(auth: EndpointAuthorizer, service: SelectionService) {
  return {
    summary: endpoint<Comp>(auth, "event.manage", ({ params }) => service.getSelectionSummary(params.organizationId, params.competitionId)),
    getLineup: endpoint<Round>(auth, "event.manage", ({ params }) =>
      service.getRoundLineup(params.organizationId, params.competitionId, params.roundId)),
    putLineup: endpoint<Round>(auth, "event.manage", ({ params, principal, body }) =>
      service.setRoundLineup(params.organizationId, params.competitionId, params.roundId, principal.accountId,
        { entryIds: body.entryIds, expectedRevision: body.expectedRevision, reason: body.reason }),
    { body: true }),
    lineupHistory: endpoint<Round>(auth, "event.manage", async ({ params }) => ({
      items: await service.listLineupHistory(params.organizationId, params.competitionId, params.roundId)
    })),
    getPanel: endpoint<Round>(auth, "event.manage", ({ params }) =>
      service.getRoundPanel(params.organizationId, params.competitionId, params.roundId)),
    assignJudge: endpoint<Round>(auth, "event.manage", ({ params, principal, body }) =>
      service.assignJudgeToRound(params.organizationId, params.competitionId, params.roundId, principal.accountId,
        { judgeId: body.judgeId, role: body.role }),
    { body: true }),
    removeJudge: endpoint<Round>(auth, "event.manage", ({ params, principal, url }) =>
      service.removeJudgeFromRound(params.organizationId, params.competitionId, params.roundId, principal.accountId,
        url.searchParams.get("judgeId")))
  };
}
