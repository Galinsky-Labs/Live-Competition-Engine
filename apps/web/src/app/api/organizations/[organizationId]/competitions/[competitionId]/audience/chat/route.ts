import { audienceHandlers } from "../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return audienceHandlers.getChat(request, { organizationId, competitionId });
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return audienceHandlers.postChat(request, { organizationId, competitionId });
}
