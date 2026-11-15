import type * as Applications from "@live-competition-engine/db/applications";
import { DomainError } from "@live-competition-engine/domain";
import { endpoint, errorResponse, intParam, type EndpointAuthorizer } from "../../../../../../../lib/competition-endpoint";

export type ApplicationsService = Pick<typeof Applications,
  | "getApplicationForm" | "saveApplicationForm" | "createApplication" | "updateApplicationDraft" | "submitApplication"
  | "withdrawApplication" | "getOwnApplication" | "getApplicationForApplicant" | "listApplicationsForReview"
  | "getApplicationForReview" | "decideApplications" | "listApplicationDecisions">;

type Comp = { organizationId: string; competitionId: string };
type App = Comp & { applicationId: string };

const revisionOf = (value: unknown) => {
  if (!Number.isSafeInteger(value)) throw new DomainError("invalid_expected_revision");
  return value as number;
};

export function createApplicationHandlers(auth: EndpointAuthorizer, service: ApplicationsService) {
  return {
    /** Applicants (any active member) read the form to fill it in. */
    getForm: endpoint<Comp>(auth, "member", async ({ params }) => {
      const form = await service.getApplicationForm(params.organizationId, params.competitionId);
      if (!form) return errorResponse(404, "application_form_not_found");
      return form;
    }),
    putForm: endpoint<Comp>(auth, "event.manage", ({ params, principal, body }) =>
      service.saveApplicationForm(params.organizationId, params.competitionId, principal.accountId, body.form, revisionOf(body.expectedRevision)),
    { body: true }),
    create: endpoint<Comp>(auth, "member", ({ params, principal, body }) =>
      service.createApplication(params.organizationId, params.competitionId, principal.accountId,
        { displayName: body.displayName, answers: body.answers }),
    { body: true, status: result => ((result as { created: boolean }).created ? 201 : 200) }),
    mine: endpoint<Comp>(auth, "member", async ({ params, principal }) => {
      const application = await service.getOwnApplication(params.organizationId, params.competitionId, principal.accountId);
      if (!application) return errorResponse(404, "application_not_found");
      return application;
    }),
    getOwn: endpoint<App>(auth, "member", ({ params, principal }) =>
      service.getApplicationForApplicant(params.organizationId, params.competitionId, params.applicationId, principal.accountId)),
    patchDraft: endpoint<App>(auth, "member", ({ params, principal, body }) =>
      service.updateApplicationDraft(params.organizationId, params.competitionId, params.applicationId, principal.accountId,
        { displayName: body.displayName, answers: body.answers, expectedRevision: body.expectedRevision }),
    { body: true }),
    submit: endpoint<App>(auth, "member", ({ params, principal, body }) =>
      service.submitApplication(params.organizationId, params.competitionId, params.applicationId, principal.accountId, body.expectedRevision),
    { body: true }),
    withdraw: endpoint<App>(auth, "member", ({ params, principal, body }) =>
      service.withdrawApplication(params.organizationId, params.competitionId, params.applicationId, principal.accountId,
        { expectedRevision: body.expectedRevision, reason: body.reason }),
    { body: true }),
    /** Producer review queue; never includes unsubmitted drafts or undisclosed contact data. */
    listForReview: endpoint<Comp>(auth, "event.manage", async ({ params, url }) => ({
      items: await service.listApplicationsForReview(params.organizationId, params.competitionId, {
        status: url.searchParams.get("status") ?? undefined, limit: intParam(url, "limit"), offset: intParam(url, "offset")
      })
    })),
    review: endpoint<App>(auth, "event.manage", ({ params }) =>
      service.getApplicationForReview(params.organizationId, params.competitionId, params.applicationId)),
    decide: endpoint<App>(auth, "event.manage", async ({ params, principal, body }) => {
      const [result] = await service.decideApplications(params.organizationId, params.competitionId, principal.accountId, [{
        applicationId: params.applicationId, status: body.status, reason: body.reason, expectedRevision: body.expectedRevision
      }]);
      return result;
    }, { body: true }),
    bulkDecide: endpoint<Comp>(auth, "event.manage", async ({ params, principal, body }) => {
      if (!Array.isArray(body.decisions)) throw new DomainError("invalid_decision_batch");
      const decisions = body.decisions.map(item => {
        if (!item || typeof item !== "object") throw new DomainError("invalid_decision_batch");
        const d = item as Record<string, unknown>;
        return { applicationId: String(d.applicationId), status: d.status, reason: d.reason, expectedRevision: d.expectedRevision };
      });
      return { items: await service.decideApplications(params.organizationId, params.competitionId, principal.accountId, decisions) };
    }, { body: true }),
    history: endpoint<App>(auth, "event.manage", async ({ params }) => ({
      items: await service.listApplicationDecisions(params.organizationId, params.competitionId, params.applicationId)
    }))
  };
}
