import { stageHandlers } from "../instance";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; stageId: string }> }) {
  const { organizationId, competitionId, stageId } = await context.params;
  return stageHandlers.update(request, organizationId, competitionId, stageId);
}
