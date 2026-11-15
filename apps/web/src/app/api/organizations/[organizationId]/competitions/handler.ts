import type { EventFields, EventPatch, EventStatus } from "@live-competition-engine/domain/events";
import type { EventRecord, PublicEvent } from "@live-competition-engine/db/events";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  optionalMember,
  readJsonObject,
  requireAction,
  type Authorizer
} from "../../../../../lib/http";
import { etag, parseIfMatch } from "../../../../../lib/revision";

export interface EventDeps {
  parseCreate(body: Record<string, unknown>): EventFields;
  parsePatch(body: Record<string, unknown>): EventPatch;
  isStatus(value: unknown): value is EventStatus;
  create(organizationId: string, actorAccountId: string, fields: EventFields): Promise<EventRecord>;
  get(organizationId: string, eventId: string): Promise<EventRecord | null>;
  history(organizationId: string, eventId: string): Promise<unknown[]>;
  update(organizationId: string, eventId: string, actorAccountId: string, patch: EventPatch, expectedRevision: number): Promise<EventRecord>;
  transition(organizationId: string, eventId: string, actorAccountId: string, to: EventStatus, expectedRevision: number, reason: string | null): Promise<EventRecord>;
  getPublic(organizationId: string, idOrSlug: string, member: boolean): Promise<PublicEvent | null>;
  listPublic(organizationId: string, options: { member?: boolean; limit?: number; offset?: number }): Promise<PublicEvent[]>;
  listManaged(organizationId: string, options: { limit?: number; offset?: number }): Promise<EventRecord[]>;
}

const notFound = () => errorResponse(404, "event_not_found");

function paging(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "");
  const offset = Number(url.searchParams.get("offset") ?? "");
  return {
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    ...(Number.isInteger(offset) && offset > 0 ? { offset } : {})
  };
}

function requireRevision(request: Request): number | Response {
  const expected = parseIfMatch(request);
  if (expected === "invalid") return errorResponse(400, "invalid_if_match");
  if (expected === null) return errorResponse(428, "if_match_required");
  return expected;
}

/**
 * Event handlers. Creating events needs tenant-level event.manage (tenant operators);
 * editing/transitions accept competition-scoped producer grants as well.
 */
export function createEventHandlers(authorizer: Authorizer, deps: EventDeps) {
  return {
    async list(request: Request, organizationId: string): Promise<Response> {
      if (new URL(request.url).searchParams.get("view") === "manage") {
        const principal = await requireAction(authorizer, request, "event.manage", { organizationId });
        if (principal instanceof Response) return principal;
        return json({ events: await deps.listManaged(organizationId, paging(request)) });
      }
      const viewer = await optionalMember(authorizer, request, organizationId);
      if (viewer instanceof Response) return viewer;
      return json({ events: await deps.listPublic(organizationId, { member: viewer !== null, ...paging(request) }) });
    },

    async create(request: Request, organizationId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId });
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 32 * 1024);
      if (body instanceof Response) return body;
      try {
        const event = await deps.create(organizationId, principal.accountId, deps.parseCreate(body));
        return json(event, 201, etag(event.revision));
      } catch (error) {
        return domainFailure(error);
      }
    },

    async get(request: Request, organizationId: string, eventId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId: eventId });
      if (principal instanceof Response) return principal;
      const event = await deps.get(organizationId, eventId);
      if (!event) return notFound();
      return json({ ...event, history: await deps.history(organizationId, eventId) }, 200, etag(event.revision));
    },

    async update(request: Request, organizationId: string, eventId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId: eventId });
      if (principal instanceof Response) return principal;
      const expected = requireRevision(request);
      if (expected instanceof Response) return expected;
      const body = await readJsonObject(request, 32 * 1024);
      if (body instanceof Response) return body;
      try {
        const event = await deps.update(organizationId, eventId, principal.accountId, deps.parsePatch(body), expected);
        return json(event, 200, etag(event.revision));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** POST { to, reason? } with If-Match. */
    async transition(request: Request, organizationId: string, eventId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId: eventId });
      if (principal instanceof Response) return principal;
      const expected = requireRevision(request);
      if (expected instanceof Response) return expected;
      const body = await readJsonObject(request, 4 * 1024);
      if (body instanceof Response) return body;
      if (!deps.isStatus(body.to)) return errorResponse(400, "invalid_status");
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") return errorResponse(400, "invalid_reason");
      try {
        const event = await deps.transition(organizationId, eventId, principal.accountId, body.to, expected,
          typeof body.reason === "string" ? body.reason : null);
        return json(event, 200, etag(event.revision));
      } catch (error) {
        return domainFailure(error);
      }
    },

    /** Anonymous public detail by id or slug. */
    async publicGet(_request: Request, organizationId: string, idOrSlug: string): Promise<Response> {
      if (!isUuid(organizationId)) return notFound();
      const event = await deps.getPublic(organizationId, idOrSlug, false);
      return event ? json(event) : notFound();
    },

    async publicList(request: Request, organizationId: string): Promise<Response> {
      if (!isUuid(organizationId)) return errorResponse(404, "not_found");
      return json({ events: await deps.listPublic(organizationId, { member: false, ...paging(request) }) });
    }
  };
}
