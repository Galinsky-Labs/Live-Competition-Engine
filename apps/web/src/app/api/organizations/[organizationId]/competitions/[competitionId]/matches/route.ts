import { bracketHandlers } from "../brackets/instance";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string }> }) {
  const { organizationId, competitionId } = await context.params;
  return bracketHandlers.createMatch(request, organizationId, competitionId);
}
