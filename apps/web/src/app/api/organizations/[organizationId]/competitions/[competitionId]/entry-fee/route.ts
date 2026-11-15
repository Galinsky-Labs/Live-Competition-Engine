import { ticketingHandlers } from "@/app/api/organizations/[organizationId]/competitions/[competitionId]/ticket-types/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return ticketingHandlers().entryFee(request, organizationId, competitionId);
}

export async function PUT(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return ticketingHandlers().configureEntryFee(request, organizationId, competitionId);
}
