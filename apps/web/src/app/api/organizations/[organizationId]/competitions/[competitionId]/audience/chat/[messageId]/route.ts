import { audienceHandlers } from "../../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; messageId: string }> }) {
  const { organizationId, competitionId, messageId } = await context.params;
  return audienceHandlers.patchChatMessage(request, { organizationId, competitionId }, messageId);
}
