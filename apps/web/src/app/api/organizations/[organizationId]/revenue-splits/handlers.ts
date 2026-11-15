import type { PaymentPurpose } from "@live-competition-engine/domain/payments";
import type { Allocation, PayoutStatement, SplitRule } from "@live-competition-engine/db/revenue-splits";
import { errorResponse, isUuid, json, readJsonObject, requireAction } from "../../../../../lib/http";
import { guarded, type MonetizationAuthorizer } from "../../../../../lib/monetization-http";

export interface SplitServices {
  list(organizationId: string, eventId?: string): Promise<SplitRule[]>;
  create(organizationId: string, input: { eventId?: string | null; purpose?: PaymentPurpose | null; lines: unknown; remainderLine?: unknown }, actorAccountId: string): Promise<SplitRule>;
  adjust(organizationId: string, orderId: string, ruleId: string, actorAccountId: string): Promise<{ ledgerTransactionId: string; allocations: Allocation[] }>;
  statement(organizationId: string, input: { accountCode: string; currency: string; from: Date; to: Date }): Promise<PayoutStatement>;
  accountCode(partyType: string, partyId: string | null): string;
}

const purposes = ["ticket", "ppv", "entry_fee", "subscription", "tip", "gift", "content"];

/** Revenue split administration, adjustments and payout statements (tenant.manage only). */
export function createSplitHandlers(authorizer: MonetizationAuthorizer, services: SplitServices) {
  const manage = (request: Request, organizationId: string) => requireAction(authorizer, request, "tenant.manage", { organizationId });
  return {
    async list(request: Request, organizationId: string) {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      const eventId = new URL(request.url).searchParams.get("eventId") ?? undefined;
      if (eventId !== undefined && !isUuid(eventId)) return errorResponse(400, "invalid_event");
      return json({ rules: await services.list(organizationId, eventId) });
    },

    async create(request: Request, organizationId: string) {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      const eventId = body.eventId ?? null;
      const purpose = body.purpose ?? null;
      if (eventId !== null && !isUuid(eventId)) return errorResponse(400, "invalid_event");
      if (purpose !== null && (typeof purpose !== "string" || !purposes.includes(purpose))) return errorResponse(400, "invalid_purpose");
      return guarded(async () => json({
        rule: await services.create(organizationId, {
          eventId: eventId as string | null, purpose: purpose as PaymentPurpose | null, lines: body.lines, remainderLine: body.remainderLine
        }, principal.accountId)
      }, 201));
    },

    async adjust(request: Request, organizationId: string, orderId: string) {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(orderId)) return errorResponse(404, "order_not_found");
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      if (!isUuid(body.ruleId)) return errorResponse(400, "invalid_rule");
      return guarded(async () => json(await services.adjust(organizationId, orderId, body.ruleId as string, principal.accountId), 201));
    },

    async statement(request: Request, organizationId: string) {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      const params = new URL(request.url).searchParams;
      const from = new Date(params.get("from") ?? "1970-01-01T00:00:00Z");
      const to = new Date(params.get("to") ?? new Date().toISOString());
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return errorResponse(400, "invalid_window");
      return guarded(async () => {
        const accountCode = services.accountCode(params.get("partyType") ?? "", params.get("partyId"));
        return json({ statement: await services.statement(organizationId, { accountCode, currency: params.get("currency") ?? "", from, to }) });
      });
    }
  };
}
