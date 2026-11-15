import type * as Judges from "@live-competition-engine/db/judges";
import { endpoint, uuidParam, type EndpointAuthorizer } from "../../../../../../../lib/competition-endpoint";

export type JudgesService = Pick<typeof Judges,
  | "inviteJudge" | "listInvitations" | "revokeInvitation" | "acceptInvitation" | "listCompetitionJudges" | "updateJudgeStatus"
  | "listJudgeAssignments" | "declareConflict" | "recuseJudge" | "rescindRecusal" | "listRecusals">;

type Comp = { organizationId: string; competitionId: string };

/**
 * LC-19. Producers (`event.manage`) manage invitations, lifecycle and recusals; an invited member
 * accepts with the token (any active member — the role is granted by acceptance); judges
 * (`judging.score` for the competition) read their assignments and declare conflicts.
 */
export function createJudgeHandlers(auth: EndpointAuthorizer, service: JudgesService) {
  return {
    list: endpoint<Comp>(auth, "event.manage", async ({ params }) => ({ items: await service.listCompetitionJudges(params.organizationId, params.competitionId) })),
    invite: endpoint<Comp>(auth, "event.manage", ({ params, principal, body }) =>
      service.inviteJudge(params.organizationId, params.competitionId, principal.accountId,
        { email: body.email, displayName: body.displayName, expiresInHours: body.expiresInHours }),
    { body: true, status: 201 }),
    listInvitations: endpoint<Comp>(auth, "event.manage", async ({ params }) => ({ items: await service.listInvitations(params.organizationId, params.competitionId) })),
    revokeInvitation: endpoint<Comp & { invitationId: string }>(auth, "event.manage", ({ params, principal }) =>
      service.revokeInvitation(params.organizationId, params.competitionId, principal.accountId, params.invitationId)),
    accept: endpoint<Comp>(auth, "member", ({ params, principal, body }) =>
      service.acceptInvitation(params.organizationId, params.competitionId, principal.accountId, body.token),
    { body: true }),
    updateStatus: endpoint<Comp & { judgeId: string }>(auth, "event.manage", ({ params, principal, body }) =>
      service.updateJudgeStatus(params.organizationId, params.competitionId, principal.accountId, params.judgeId,
        { status: body.status, expectedRevision: body.expectedRevision, reason: body.reason }),
    { body: true }),
    listRecusals: endpoint<Comp>(auth, "event.manage", async ({ params, url }) => ({
      items: await service.listRecusals(params.organizationId, params.competitionId, { judgeId: uuidParam(url, "judgeId") })
    })),
    recuse: endpoint<Comp>(auth, "event.manage", ({ params, principal, body }) =>
      service.recuseJudge(params.organizationId, params.competitionId, principal.accountId,
        { judgeId: body.judgeId, entryId: body.entryId, reason: body.reason }),
    { body: true, status: 201 }),
    rescind: endpoint<Comp & { recusalId: string }>(auth, "event.manage", ({ params, principal, body }) =>
      service.rescindRecusal(params.organizationId, params.competitionId, principal.accountId, params.recusalId, body.reason),
    { body: true }),
    assignments: endpoint<Comp>(auth, "judging.score", ({ params, principal }) =>
      service.listJudgeAssignments(params.organizationId, params.competitionId, principal.accountId)),
    declareConflict: endpoint<Comp>(auth, "judging.score", ({ params, principal, body }) =>
      service.declareConflict(params.organizationId, params.competitionId, principal.accountId, { entryId: body.entryId, reason: body.reason }),
    { body: true, status: 201 })
  };
}
