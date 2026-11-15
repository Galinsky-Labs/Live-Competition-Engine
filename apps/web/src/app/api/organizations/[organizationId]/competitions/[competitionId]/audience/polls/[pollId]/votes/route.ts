import { audienceHandlers } from "../../../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; pollId: string }> }) {
  const { organizationId, competitionId, pollId } = await context.params;
  return audienceHandlers.postPollVote(request, { organizationId, competitionId }, pollId);
}
