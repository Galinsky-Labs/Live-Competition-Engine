import { votingHandlers } from "../../../../../../../../lib/voting-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return votingHandlers.listWindows(request, { organizationId, competitionId });
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return votingHandlers.createWindow(request, { organizationId, competitionId });
}
