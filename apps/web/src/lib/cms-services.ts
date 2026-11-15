import * as cms from "@live-competition-engine/db/cms";
import { createCmsHandlers, type CmsService } from "../app/api/organizations/[organizationId]/cms/handlers";
import { authService } from "./services";

export const cmsService: CmsService = {
  listPages: cms.listPages,
  createPage: (org, actor, input) => cms.createPage(org, actor, input),
  getPageForEditing: cms.getPageForEditing,
  updateDraft: (org, actor, id, input) => cms.updateDraft(org, actor, id, input),
  publishPage: cms.publishPage,
  rollbackPage: cms.rollbackPage,
  schedulePublish: (org, actor, id, input) => cms.schedulePublish(org, actor, id, input),
  cancelScheduledPublish: cms.cancelScheduledPublish,
  setNavigation: cms.setNavigation,
  listNavigation: cms.listNavigation,
  getPublishedPage: cms.getPublishedPage
};

let handlers: ReturnType<typeof createCmsHandlers> | undefined;

export function cmsHandlers() {
  handlers ??= createCmsHandlers(authService(), cmsService);
  return handlers;
}
