import { ticketingHandlers } from "@/app/api/organizations/[organizationId]/competitions/[competitionId]/ticket-types/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; competitionId: string; ticketTypeId: string }> };

export async function PATCH(request: Request, context: Context) {
  const { organizationId, competitionId, ticketTypeId } = await context.params;
  return ticketingHandlers().update(request, organizationId, competitionId, ticketTypeId);
}
