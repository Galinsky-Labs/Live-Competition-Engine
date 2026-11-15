import { audienceHandlers } from "../../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; pollId: string }> }) {
  const { organizationId, competitionId, pollId } = await context.params;
  return audienceHandlers.getPollOne(request, { organizationId, competitionId }, pollId);
}

export async function PATCH(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; pollId: string }> }) {
  const { organizationId, competitionId, pollId } = await context.params;
  return audienceHandlers.patchPoll(request, { organizationId, competitionId }, pollId);
}
