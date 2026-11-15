import type { AuthorizedPrincipal } from "@live-competition-engine/auth";
import type { PublishedPage } from "@live-competition-engine/db/cms";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  type Authorizer
} from "../../../../../lib/http";

export interface CmsService {
  listPages(org: string): Promise<unknown[]>;
  createPage(org: string, actor: string, input: Record<string, unknown>): Promise<{ id: string }>;
  getPageForEditing(org: string, pageId: string): Promise<unknown | null>;
  updateDraft(org: string, actor: string, pageId: string, input: Record<string, unknown>): Promise<{ draftRevision: number }>;
  publishPage(org: string, actor: string, pageId: string, input: { expectedDraftRevision?: unknown }): Promise<{ version: number }>;
  rollbackPage(org: string, actor: string, pageId: string, input: { version?: unknown }): Promise<{ version: number }>;
  schedulePublish(org: string, actor: string, pageId: string, input: { publishAt?: unknown; expectedDraftRevision?: unknown }): Promise<unknown>;
  cancelScheduledPublish(org: string, actor: string, pageId: string): Promise<void>;
  setNavigation(org: string, actor: string, entries: unknown): Promise<{ count: number }>;
  listNavigation(org: string, options?: { publicOnly?: boolean }): Promise<unknown[]>;
  getPublishedPage(org: string, slug: string): Promise<PublishedPage | null>;
}

async function asEditor(
  authorizer: Authorizer, request: Request, organizationId: string, run: (principal: AuthorizedPrincipal) => Promise<Response>
): Promise<Response> {
  const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
  if (principal instanceof Response) return principal;
  try {
    return await run(principal);
  } catch (error) {
    return domainFailure(error);
  }
}

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  return readJsonObject(request, 512 * 1024);
}

const publicHeaders = { "cache-control": "public, max-age=60" };

export function createCmsHandlers(authorizer: Authorizer, service: CmsService) {
  return {
    listPages: (request: Request, org: string) => asEditor(authorizer, request, org, async () => json({ pages: await service.listPages(org) })),

    createPage: (request: Request, org: string) => asEditor(authorizer, request, org, async principal => {
      const input = await body(request);
      if (input instanceof Response) return input;
      return json(await service.createPage(org, principal.accountId, input), 201);
    }),

    getPage: (request: Request, org: string, pageId: string) => asEditor(authorizer, request, org, async () => {
      const page = isUuid(pageId) ? await service.getPageForEditing(org, pageId) : null;
      return page ? json(page) : errorResponse(404, "page_not_found");
    }),

    updateDraft: (request: Request, org: string, pageId: string) => asEditor(authorizer, request, org, async principal => {
      const input = await body(request);
      if (input instanceof Response) return input;
      return json(await service.updateDraft(org, principal.accountId, pageId, input));
    }),

    publish: (request: Request, org: string, pageId: string) => asEditor(authorizer, request, org, async principal => {
      const input = await body(request);
      if (input instanceof Response) return input;
      return json(await service.publishPage(org, principal.accountId, pageId, { expectedDraftRevision: input.expectedDraftRevision }), 201);
    }),

    rollback: (request: Request, org: string, pageId: string) => asEditor(authorizer, request, org, async principal => {
      const input = await body(request);
      if (input instanceof Response) return input;
      return json(await service.rollbackPage(org, principal.accountId, pageId, { version: input.version }), 201);
    }),

    schedule: (request: Request, org: string, pageId: string) => asEditor(authorizer, request, org, async principal => {
      const input = await body(request);
      if (input instanceof Response) return input;
      return json(await service.schedulePublish(org, principal.accountId, pageId, {
        publishAt: input.publishAt, expectedDraftRevision: input.expectedDraftRevision
      }), 201);
    }),

    cancelSchedule: (request: Request, org: string, pageId: string) => asEditor(authorizer, request, org, async principal => {
      await service.cancelScheduledPublish(org, principal.accountId, pageId);
      return json({ pageId, cancelled: true });
    }),

    getNavigation: (request: Request, org: string) => asEditor(authorizer, request, org, async () => json({ entries: await service.listNavigation(org) })),

    setNavigation: (request: Request, org: string) => asEditor(authorizer, request, org, async principal => {
      const input = await body(request);
      if (input instanceof Response) return input;
      return json(await service.setNavigation(org, principal.accountId, input.entries));
    }),

    /** Public, anonymous: only the published projection. Unknown, hidden or disabled → 404. */
    async publicPage(_request: Request, org: string, slug: string): Promise<Response> {
      if (!isUuid(org)) return errorResponse(404, "page_not_found");
      const page = await service.getPublishedPage(org, slug);
      if (!page) return errorResponse(404, "page_not_found");
      return json({ slug: page.slug, title: page.title, html: page.html, version: page.version, publishedAt: page.publishedAt, mediaIds: page.mediaIds }, 200, publicHeaders);
    },

    async publicNavigation(_request: Request, org: string): Promise<Response> {
      if (!isUuid(org)) return errorResponse(404, "not_found");
      return json({ entries: await service.listNavigation(org, { publicOnly: true }) }, 200, publicHeaders);
    }
  };
}
