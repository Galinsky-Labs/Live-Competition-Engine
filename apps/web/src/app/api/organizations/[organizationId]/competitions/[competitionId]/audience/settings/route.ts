import { audienceHandlers } from "../../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return audienceHandlers.getSettings(request, { organizationId, competitionId });
}

export async function PUT(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return audienceHandlers.putSettings(request, { organizationId, competitionId });
}
