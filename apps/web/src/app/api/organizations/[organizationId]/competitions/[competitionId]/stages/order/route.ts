import { stageHandlers } from "../instance";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return stageHandlers.reorder(request, organizationId, competitionId);
}
