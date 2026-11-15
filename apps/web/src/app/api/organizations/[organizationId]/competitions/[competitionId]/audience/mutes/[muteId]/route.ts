import { audienceHandlers } from "../../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; muteId: string }> }) {
  const { organizationId, competitionId, muteId } = await context.params;
  return audienceHandlers.deleteMute(request, { organizationId, competitionId }, muteId);
}
