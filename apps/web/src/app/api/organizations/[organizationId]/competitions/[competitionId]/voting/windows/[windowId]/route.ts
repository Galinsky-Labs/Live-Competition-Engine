import { votingHandlers } from "../../../../../../../../../lib/voting-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; windowId: string }> }) {
  const { organizationId, competitionId, windowId } = await context.params;
  return votingHandlers.getWindow(request, { organizationId, competitionId }, windowId);
}

export async function PATCH(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; windowId: string }> }) {
  const { organizationId, competitionId, windowId } = await context.params;
  return votingHandlers.patchWindow(request, { organizationId, competitionId }, windowId);
}
