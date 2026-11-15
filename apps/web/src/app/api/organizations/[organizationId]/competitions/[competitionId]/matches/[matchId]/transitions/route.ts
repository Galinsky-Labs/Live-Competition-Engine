import { bracketHandlers } from "../../../brackets/instance";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; matchId: string }> }) {
  const { organizationId, competitionId, matchId } = await context.params;
  return bracketHandlers.actOnMatch(request, organizationId, competitionId, matchId);
}
