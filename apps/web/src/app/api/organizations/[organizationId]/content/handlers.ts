import type { AuthenticationService } from "@live-competition-engine/auth";
import { validateContentInput, type ContentInput } from "@live-competition-engine/domain/paywalls";
import type { ContentItem, ContentView, ContentViewer } from "@live-competition-engine/db/paywalls";
import type { PurchaseResult } from "@live-competition-engine/db/ticketing";
import { errorResponse, isUuid, json, optionalMember, readJsonObject, requireAction, requireMember } from "../../../../../lib/http";
import { guarded, idempotencyKeyOf, type MonetizationAuthorizer } from "../../../../../lib/monetization-http";

export interface ContentServices {
  list(organizationId: string, viewer: ContentViewer, options: { eventId?: string }): Promise<ContentView[]>;
  get(organizationId: string, itemId: string, viewer: ContentViewer): Promise<ContentView | null>;
  create(organizationId: string, input: ContentInput, actorAccountId: string, status: "draft" | "published"): Promise<ContentItem>;
  purchase(organizationId: string, input: { itemId: string; accountId: string; idempotencyKey: string }): Promise<PurchaseResult>;
  orderView(order: PurchaseResult["order"]): unknown;
}

async function isManager(authorizer: Pick<AuthenticationService, "authorizeAction">, request: Request, organizationId: string): Promise<boolean> {
  try {
    await authorizer.authorizeAction(request.headers.get("authorization"), "tenant.manage", { organizationId });
    return true;
  } catch {
    return false;
  }
}

/** LC-35 handlers: list/read with teaser-vs-full projection, publish, purchase. */
export function createContentHandlers(authorizer: MonetizationAuthorizer, services: ContentServices) {
  const viewerOf = async (request: Request, organizationId: string): Promise<ContentViewer | Response> => {
    const principal = await optionalMember(authorizer, request, organizationId);
    if (principal instanceof Response) return principal;
    if (!principal) return { accountId: null, isManager: false };
    return { accountId: principal.accountId, isManager: await isManager(authorizer, request, organizationId) };
  };

  return {
    async list(request: Request, organizationId: string) {
      if (!isUuid(organizationId)) return errorResponse(404, "not_found");
      const viewer = await viewerOf(request, organizationId);
      if (viewer instanceof Response) return viewer;
      const eventId = new URL(request.url).searchParams.get("eventId") ?? undefined;
      if (eventId !== undefined && !isUuid(eventId)) return errorResponse(400, "invalid_event");
      return json({ items: await services.list(organizationId, viewer, eventId ? { eventId } : {}) });
    },

    async get(request: Request, organizationId: string, itemId: string) {
      if (!isUuid(organizationId) || !isUuid(itemId)) return errorResponse(404, "content_not_found");
      const viewer = await viewerOf(request, organizationId);
      if (viewer instanceof Response) return viewer;
      const item = await services.get(organizationId, itemId, viewer);
      return item ? json({ item }) : errorResponse(404, "content_not_found");
    },

    /** Creators publish as themselves; tenant/participant content needs tenant.manage. */
    async create(request: Request, organizationId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const status = body.status ?? "published";
      if (status !== "draft" && status !== "published") return errorResponse(400, "invalid_status");
      return guarded(async () => {
        const input = validateContentInput(body);
        if (!(input.creatorType === "account" && input.creatorId === principal.accountId)) {
          const manager = await requireAction(authorizer, request, "tenant.manage", { organizationId });
          if (manager instanceof Response) return manager;
        }
        const item = await services.create(organizationId, input, principal.accountId, status);
        return json({ item: { id: item.id, accessRule: item.accessRule, status: item.status } }, 201);
      });
    },

    async purchase(request: Request, organizationId: string, itemId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(itemId)) return errorResponse(404, "content_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const idempotencyKey = idempotencyKeyOf(request, body);
      if (!idempotencyKey) return errorResponse(400, "invalid_idempotency_key");
      return guarded(async () => {
        const result = await services.purchase(organizationId, { itemId, accountId: principal.accountId, idempotencyKey });
        return json({ order: services.orderView(result.order), redirectUrl: result.redirectUrl }, 201);
      });
    }
  };
}
