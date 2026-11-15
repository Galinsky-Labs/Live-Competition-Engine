import { votingHandlers } from "../../../../../../../../../../lib/voting-handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; windowId: string }> }) {
  const { organizationId, competitionId, windowId } = await context.params;
  return votingHandlers.castBallot(request, { organizationId, competitionId }, windowId);
}
