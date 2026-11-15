import { eventHandlers } from "../../../../../organizations/[organizationId]/competitions/instance";

export const dynamic = "force-dynamic";

/** competitionId accepts the event id or its public slug. */
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return eventHandlers.publicGet(request, organizationId, competitionId);
}
