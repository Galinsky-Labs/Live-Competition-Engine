import { resolveCname, resolveTxt } from "node:dns/promises";
import * as email from "@live-competition-engine/db/white-label-email";
import { createWhiteLabelEmailHandlers, type WhiteLabelEmailService } from "../app/api/organizations/[organizationId]/email/handlers";
import { createUnsubscribeHandlers } from "../app/api/public/organizations/[organizationId]/unsubscribe/handler";
import { authService } from "./services";

export const whiteLabelEmailService: WhiteLabelEmailService = {
  listSenderIdentities: email.listSenderIdentities,
  createSenderIdentity: (org, actor, input) => email.createSenderIdentity(org, actor, input),
  checkSenderIdentityDns: (org, actor, id) => email.checkSenderIdentityDns(org, actor, id, { resolveTxt, resolveCname }),
  setDefaultSender: email.setDefaultSender,
  listTemplates: email.listTemplates,
  createTemplate: (org, actor, input) => email.createTemplate(org, actor, input),
  addTemplateVersion: (org, actor, id, input) => email.addTemplateVersion(org, actor, id, input),
  activateTemplateVersion: email.activateTemplateVersion,
  previewTemplate: email.previewTemplate,
  deliverabilitySummary: org => email.deliverabilitySummary(org),
  getEmailTrace: email.getEmailTrace
};

let admin: ReturnType<typeof createWhiteLabelEmailHandlers> | undefined;
export function whiteLabelEmailHandlers() {
  admin ??= createWhiteLabelEmailHandlers(authService(), whiteLabelEmailService);
  return admin;
}

let unsubscribe: ReturnType<typeof createUnsubscribeHandlers> | undefined;
export function unsubscribeHandlers() {
  unsubscribe ??= createUnsubscribeHandlers(email.verifyUnsubscribeToken, email.applyUnsubscribe);
  return unsubscribe;
}
