import { parseTemplateName } from "@live-competition-engine/domain/contest-templates";
import {
  applyTemplateVersion,
  createContestTemplate,
  getAppliedTemplate,
  getContestTemplate,
  listContestTemplates,
  publishContestTemplateDraft,
  saveContestTemplateDraft
} from "@live-competition-engine/db/contest-templates";
import { authService } from "../../../../../lib/services";
import { createTemplateHandlers } from "./handler";

export const templateHandlers = createTemplateHandlers(authService(), {
  parseName: parseTemplateName,
  create: createContestTemplate,
  get: (organizationId, templateId) => getContestTemplate(organizationId, templateId),
  list: listContestTemplates,
  saveDraft: saveContestTemplateDraft,
  publish: publishContestTemplateDraft,
  apply: applyTemplateVersion,
  getApplied: getAppliedTemplate
});
