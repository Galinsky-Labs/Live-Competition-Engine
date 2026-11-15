import { audienceHandlers } from "../../../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; questionId: string }> }) {
  const { organizationId, competitionId, questionId } = await context.params;
  return audienceHandlers.postUpvote(request, { organizationId, competitionId }, questionId);
}
