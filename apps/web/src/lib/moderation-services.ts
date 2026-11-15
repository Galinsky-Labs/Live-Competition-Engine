import * as moderation from "@live-competition-engine/db/moderation";
import { createModerationHandlers, type ModerationService } from "../app/api/organizations/[organizationId]/moderation/handlers";
import { authService } from "./services";

export const moderationService: ModerationService = {
  submitReport: (org, reporter, input) => moderation.submitReport(org, reporter, input),
  listReports: moderation.listReports,
  getReport: moderation.getReport,
  transitionReport: (org, actor, id, input) => moderation.transitionReport(org, actor, id, input),
  addEvidence: moderation.addEvidence,
  deleteReport: moderation.deleteReport,
  takeModerationAction: (org, actor, input) => moderation.takeModerationAction(org, actor, input),
  reverseModerationAction: (org, actor, id, reason) => moderation.reverseModerationAction(org, actor, id, reason),
  listActions: moderation.listActions,
  listActionsAffecting: moderation.listActionsAffecting,
  fileAppeal: (org, appellant, actionId, statement) => moderation.fileAppeal(org, appellant, actionId, statement),
  decideAppeal: (org, actor, id, input) => moderation.decideAppeal(org, actor, id, input),
  listAppeals: moderation.listAppeals,
  placeLegalHold: moderation.placeLegalHold,
  releaseLegalHold: moderation.releaseLegalHold
};

let handlers: ReturnType<typeof createModerationHandlers> | undefined;

export function moderationHandlers() {
  handlers ??= createModerationHandlers(authService(), moderationService);
  return handlers;
}
