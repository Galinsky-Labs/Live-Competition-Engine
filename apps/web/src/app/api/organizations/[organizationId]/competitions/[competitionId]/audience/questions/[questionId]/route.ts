import { audienceHandlers } from "../../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; questionId: string }> }) {
  const { organizationId, competitionId, questionId } = await context.params;
  return audienceHandlers.patchQuestion(request, { organizationId, competitionId }, questionId);
}
