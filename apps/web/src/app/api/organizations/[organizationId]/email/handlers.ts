import type { AuthorizedPrincipal } from "@live-competition-engine/auth";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  type Authorizer
} from "../../../../../lib/http";

export interface WhiteLabelEmailService {
  listSenderIdentities(org: string): Promise<unknown[]>;
  createSenderIdentity(org: string, actor: string, input: Record<string, unknown>): Promise<unknown>;
  checkSenderIdentityDns(org: string, actor: string, senderId: string): Promise<unknown>;
  setDefaultSender(org: string, actor: string, senderId: string): Promise<void>;
  listTemplates(org: string): Promise<unknown[]>;
  createTemplate(org: string, actor: string, input: Record<string, unknown>): Promise<{ id: string }>;
  addTemplateVersion(org: string, actor: string, templateId: string, input: Record<string, unknown>): Promise<unknown>;
  activateTemplateVersion(org: string, actor: string, templateId: string, version: unknown): Promise<void>;
  previewTemplate(org: string, templateId: string, input: { version?: unknown; variables?: unknown }): Promise<unknown>;
  deliverabilitySummary(org: string): Promise<unknown>;
  getEmailTrace(org: string, messageId: string): Promise<unknown | null>;
}

/** Tenant email administration (`tenant.manage`). DNS checks run server-side only for the stored identity. */
export function createWhiteLabelEmailHandlers(authorizer: Authorizer, service: WhiteLabelEmailService) {
  async function admin(request: Request, org: string, run: (principal: AuthorizedPrincipal) => Promise<Response>): Promise<Response> {
    const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId: org });
    if (principal instanceof Response) return principal;
    try {
      return await run(principal);
    } catch (error) {
      return domainFailure(error, { invalid_state_domain_unverified: 409, invalid_state_sender_unverified: 409 });
    }
  }
  const withBody = async (request: Request, run: (body: Record<string, unknown>) => Promise<Response>) => {
    const body = await readJsonObject(request, 128 * 1024);
    return body instanceof Response ? body : run(body);
  };

  return {
    listSenders: (request: Request, org: string) => admin(request, org, async () => json({ senders: await service.listSenderIdentities(org) })),
    createSender: (request: Request, org: string) => admin(request, org, p => withBody(request, async body =>
      json(await service.createSenderIdentity(org, p.accountId, body), 201))),
    verifySender: (request: Request, org: string, senderId: string) => admin(request, org, async p =>
      json(await service.checkSenderIdentityDns(org, p.accountId, senderId))),
    defaultSender: (request: Request, org: string, senderId: string) => admin(request, org, async p => {
      await service.setDefaultSender(org, p.accountId, senderId);
      return json({ id: senderId, isDefault: true });
    }),
    listTemplates: (request: Request, org: string) => admin(request, org, async () => json({ templates: await service.listTemplates(org) })),
    createTemplate: (request: Request, org: string) => admin(request, org, p => withBody(request, async body =>
      json(await service.createTemplate(org, p.accountId, body), 201))),
    addVersion: (request: Request, org: string, templateId: string) => admin(request, org, p => withBody(request, async body =>
      json(await service.addTemplateVersion(org, p.accountId, templateId, body), 201))),
    activate: (request: Request, org: string, templateId: string) => admin(request, org, p => withBody(request, async body => {
      await service.activateTemplateVersion(org, p.accountId, templateId, body.version);
      return json({ templateId, activeVersion: body.version });
    })),
    preview: (request: Request, org: string, templateId: string) => admin(request, org, () => withBody(request, async body =>
      json(await service.previewTemplate(org, templateId, { version: body.version, variables: body.variables })))),
    deliverability: (request: Request, org: string) => admin(request, org, async () => json(await service.deliverabilitySummary(org))),
    trace: (request: Request, org: string, messageId: string) => admin(request, org, async () => {
      const trace = isUuid(messageId) ? await service.getEmailTrace(org, messageId) : null;
      return trace ? json(trace) : errorResponse(404, "email_message_not_found");
    })
  };
}
