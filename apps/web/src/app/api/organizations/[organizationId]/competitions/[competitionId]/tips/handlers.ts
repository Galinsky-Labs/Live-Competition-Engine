import { validateTipPolicy, type TipPolicy } from "@live-competition-engine/domain/tips";
import type { PurchaseResult } from "@live-competition-engine/db/ticketing";
import type { Gift, TipQuote, TipRequest } from "@live-competition-engine/db/tips";
import { errorResponse, isUuid, json, readJsonObject, requireAction, requireMember } from "../../../../../../../lib/http";
import { guarded, idempotencyKeyOf, type MonetizationAuthorizer } from "../../../../../../../lib/monetization-http";

export interface TipServices {
  listGifts(organizationId: string, context: { eventId?: string; accountId?: string }): Promise<Gift[]>;
  createGift(organizationId: string, input: { name: unknown; priceMinor: unknown; currency: unknown }, actorAccountId: string): Promise<Gift>;
  setPolicy(organizationId: string, policy: TipPolicy, actorAccountId: string): Promise<TipPolicy>;
  linkPayout(organizationId: string, participantId: string, accountId: string, actorAccountId: string): Promise<void>;
  quote(organizationId: string, request: TipRequest, senderAccountId: string): Promise<TipQuote>;
  send(organizationId: string, input: TipRequest & { senderAccountId: string; expected: { grossMinor: unknown; payeeMinor: unknown }; message?: string | null; idempotencyKey: string }): Promise<PurchaseResult & { tipId: string }>;
  feed(organizationId: string, eventId: string, accountId: string): Promise<unknown[]>;
  orderView(order: PurchaseResult["order"]): unknown;
}

function tipRequest(body: Record<string, unknown>, eventId: string): TipRequest | Response {
  if (body.payeeType !== "participant" && body.payeeType !== "account") return errorResponse(400, "invalid_payee");
  if (!isUuid(body.payeeId)) return errorResponse(400, "invalid_payee");
  if (body.giftId !== undefined && body.giftId !== null && !isUuid(body.giftId)) return errorResponse(400, "invalid_gift");
  if (body.quantity !== undefined && !Number.isSafeInteger(body.quantity)) return errorResponse(400, "invalid_quantity");
  if (body.amountMinor !== undefined && !Number.isSafeInteger(body.amountMinor)) return errorResponse(400, "invalid_amount");
  return {
    eventId, payeeType: body.payeeType, payeeId: body.payeeId as string,
    ...(body.giftId ? { giftId: body.giftId as string } : {}),
    ...(body.quantity !== undefined ? { quantity: body.quantity as number } : {}),
    ...(body.amountMinor !== undefined ? { amountMinor: body.amountMinor as number } : {}),
    ...(typeof body.currency === "string" ? { currency: body.currency } : {})
  };
}

/** LC-36 handlers: gift catalog, tip policy, payout links, quotes, tips and the event tip feed. */
export function createTipHandlers(authorizer: MonetizationAuthorizer, services: TipServices) {
  const manage = (request: Request, organizationId: string) => requireAction(authorizer, request, "tenant.manage", { organizationId });
  return {
    async listGifts(request: Request, organizationId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      const eventId = new URL(request.url).searchParams.get("eventId") ?? undefined;
      if (eventId !== undefined && !isUuid(eventId)) return errorResponse(400, "invalid_event");
      return guarded(async () => json({ gifts: await services.listGifts(organizationId, { accountId: principal.accountId, ...(eventId ? { eventId } : {}) }) }));
    },

    async createGift(request: Request, organizationId: string) {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      return guarded(async () => json({ gift: await services.createGift(organizationId, { name: body.name, priceMinor: body.priceMinor, currency: body.currency }, principal.accountId) }, 201));
    },

    async setPolicy(request: Request, organizationId: string) {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      return guarded(async () => json({ policy: await services.setPolicy(organizationId, validateTipPolicy(body), principal.accountId) }));
    },

    async linkPayout(request: Request, organizationId: string, participantId: string) {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(participantId)) return errorResponse(404, "participant_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      if (!isUuid(body.accountId)) return errorResponse(400, "invalid_account");
      return guarded(async () => {
        try {
          await services.linkPayout(organizationId, participantId, body.accountId as string, principal.accountId);
        } catch (error) {
          if ((error as { code?: string }).code === "23503") return errorResponse(404, "participant_not_found");
          throw error;
        }
        return json({ linked: true });
      });
    },

    async quote(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(competitionId)) return errorResponse(404, "event_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const tip = tipRequest(body, competitionId);
      if (tip instanceof Response) return tip;
      return guarded(async () => json({ quote: await services.quote(organizationId, tip, principal.accountId) }));
    },

    async send(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(competitionId)) return errorResponse(404, "event_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const tip = tipRequest(body, competitionId);
      if (tip instanceof Response) return tip;
      const idempotencyKey = idempotencyKeyOf(request, body);
      if (!idempotencyKey) return errorResponse(400, "invalid_idempotency_key");
      const accepted = body.acceptedQuote as { grossMinor?: unknown; payeeMinor?: unknown } | undefined;
      if (!accepted || typeof accepted !== "object") return errorResponse(400, "quote_required");
      if (body.message !== undefined && body.message !== null && typeof body.message !== "string") return errorResponse(400, "invalid_message");
      return guarded(async () => {
        const result = await services.send(organizationId, {
          ...tip, senderAccountId: principal.accountId, expected: { grossMinor: accepted.grossMinor, payeeMinor: accepted.payeeMinor },
          message: (body.message as string | null | undefined) ?? null, idempotencyKey
        });
        return json({ tipId: result.tipId, order: services.orderView(result.order), redirectUrl: result.redirectUrl }, 201);
      });
    },

    async feed(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(competitionId)) return errorResponse(404, "event_not_found");
      return guarded(async () => json({ tips: await services.feed(organizationId, competitionId, principal.accountId) }));
    }
  };
}
