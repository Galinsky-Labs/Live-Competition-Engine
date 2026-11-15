import { ticketingHandlers } from "@/app/api/organizations/[organizationId]/competitions/[competitionId]/ticket-types/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return ticketingHandlers().access(request, organizationId, competitionId);
}
