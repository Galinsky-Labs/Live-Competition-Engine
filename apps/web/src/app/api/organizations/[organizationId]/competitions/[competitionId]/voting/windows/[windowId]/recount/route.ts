import { integrityHandlers } from "../../../../../../../../../../lib/voting-handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; windowId: string }> }) {
  const { organizationId, competitionId, windowId } = await context.params;
  return integrityHandlers.postRecount(request, { organizationId, competitionId }, windowId);
}
