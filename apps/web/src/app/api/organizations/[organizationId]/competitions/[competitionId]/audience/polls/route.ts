import { audienceHandlers } from "../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return audienceHandlers.getPolls(request, { organizationId, competitionId });
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return audienceHandlers.postPoll(request, { organizationId, competitionId });
}
