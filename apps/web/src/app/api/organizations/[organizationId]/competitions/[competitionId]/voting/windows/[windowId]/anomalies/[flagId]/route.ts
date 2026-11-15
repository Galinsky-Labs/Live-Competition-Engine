import { integrityHandlers } from "../../../../../../../../../../../lib/voting-handlers";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; windowId: string; flagId: string }> }) {
  const { organizationId, competitionId, windowId, flagId } = await context.params;
  return integrityHandlers.patchAnomaly(request, { organizationId, competitionId }, windowId, flagId);
}
