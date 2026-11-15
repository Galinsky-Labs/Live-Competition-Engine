import { eventHandlers } from "../../instance";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return eventHandlers.transition(request, organizationId, competitionId);
}
