import { validateTicketTypeInput, type TicketTypeInput } from "@live-competition-engine/domain/ticketing";
import type { AccessGate, EntryFee, EntryFeeGate, PurchaseResult, TicketType } from "@live-competition-engine/db/ticketing";
import { errorResponse, isUuid, json, optionalMember, readJsonObject, requireAction, requireMember } from "../../../../../../../lib/http";
import { guarded, idempotencyKeyOf, type MonetizationAuthorizer } from "../../../../../../../lib/monetization-http";

export interface TicketingServices {
  list(organizationId: string, eventId: string, accountId?: string): Promise<TicketType[]>;
  view(type: TicketType): unknown;
  create(organizationId: string, eventId: string, input: TicketTypeInput, actorAccountId: string): Promise<TicketType>;
  setStatus(organizationId: string, eventId: string, ticketTypeId: string, status: TicketType["status"], expectedRevision: number, actorAccountId: string): Promise<TicketType>;
  purchase(organizationId: string, input: { eventId: string; ticketTypeId: string; accountId: string; idempotencyKey: string }): Promise<PurchaseResult>;
  access(organizationId: string, eventId: string, accountId: string | null, mode: "enter" | "view"): Promise<AccessGate>;
  entryFeeGate(organizationId: string, competitionId: string, accountId: string): Promise<EntryFeeGate>;
  setEntryFee(organizationId: string, competitionId: string, input: { priceMinor: number; currency: string; active: boolean; expectedRevision: number }, actorAccountId: string): Promise<EntryFee>;
  purchaseEntryFee(organizationId: string, input: { competitionId: string; accountId: string; idempotencyKey: string }): Promise<PurchaseResult>;
  orderView(order: PurchaseResult["order"]): unknown;
}

const statuses = ["on_sale", "paused", "archived"];

/** LC-33 handlers: ticket types, purchases, event access gate and entry fees. */
export function createTicketingHandlers(authorizer: MonetizationAuthorizer, services: TicketingServices) {
  const purchaseResponse = (result: PurchaseResult) =>
    json({ order: services.orderView(result.order), redirectUrl: result.redirectUrl }, result.redirectUrl ? 201 : 200);

  return {
    async list(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(competitionId)) return errorResponse(404, "event_not_found");
      return guarded(async () => json({ ticketTypes: (await services.list(organizationId, competitionId, principal.accountId)).map(services.view) }));
    },

    async create(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId });
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      return guarded(async () => {
        const input = validateTicketTypeInput(body);
        return json({ ticketType: services.view(await services.create(organizationId, competitionId, input, principal.accountId)) }, 201);
      });
    },

    async update(request: Request, organizationId: string, competitionId: string, ticketTypeId: string) {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId });
      if (principal instanceof Response) return principal;
      if (!isUuid(ticketTypeId)) return errorResponse(404, "ticket_type_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      if (typeof body.status !== "string" || !statuses.includes(body.status)) return errorResponse(400, "invalid_status");
      if (!Number.isSafeInteger(body.expectedRevision)) return errorResponse(400, "invalid_revision");
      return guarded(async () => json({
        ticketType: services.view(await services.setStatus(organizationId, competitionId, ticketTypeId, body.status as TicketType["status"], body.expectedRevision as number, principal.accountId))
      }));
    },

    async purchase(request: Request, organizationId: string, competitionId: string, ticketTypeId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(competitionId) || !isUuid(ticketTypeId)) return errorResponse(404, "ticket_type_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const idempotencyKey = idempotencyKeyOf(request, body);
      if (!idempotencyKey) return errorResponse(400, "invalid_idempotency_key");
      return guarded(async () => purchaseResponse(await services.purchase(organizationId, {
        eventId: competitionId, ticketTypeId, accountId: principal.accountId, idempotencyKey
      })));
    },

    async access(request: Request, organizationId: string, competitionId: string) {
      const principal = await optionalMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(organizationId) || !isUuid(competitionId)) return errorResponse(404, "event_not_found");
      const mode = new URL(request.url).searchParams.get("mode") ?? "enter";
      if (mode !== "enter" && mode !== "view") return errorResponse(400, "invalid_mode");
      return guarded(async () => json({ access: await services.access(organizationId, competitionId, principal?.accountId ?? null, mode) }));
    },

    async entryFee(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(competitionId)) return errorResponse(404, "event_not_found");
      return guarded(async () => json({ entryFee: await services.entryFeeGate(organizationId, competitionId, principal.accountId) }));
    },

    async configureEntryFee(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId });
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      if (!Number.isSafeInteger(body.priceMinor) || (body.priceMinor as number) <= 0) return errorResponse(400, "invalid_amount");
      if (typeof body.currency !== "string") return errorResponse(400, "invalid_currency");
      if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) return errorResponse(400, "invalid_revision");
      return guarded(async () => json({
        entryFee: await services.setEntryFee(organizationId, competitionId, {
          priceMinor: body.priceMinor as number, currency: body.currency as string, active: body.active !== false, expectedRevision: body.expectedRevision as number
        }, principal.accountId)
      }));
    },

    async purchaseEntryFee(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(competitionId)) return errorResponse(404, "event_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const idempotencyKey = idempotencyKeyOf(request, body);
      if (!idempotencyKey) return errorResponse(400, "invalid_idempotency_key");
      return guarded(async () => purchaseResponse(await services.purchaseEntryFee(organizationId, {
        competitionId, accountId: principal.accountId, idempotencyKey
      })));
    }
  };
}
