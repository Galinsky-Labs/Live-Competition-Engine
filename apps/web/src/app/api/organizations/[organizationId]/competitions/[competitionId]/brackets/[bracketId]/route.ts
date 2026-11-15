import { bracketHandlers } from "../instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; bracketId: string }> }) {
  const { organizationId, competitionId, bracketId } = await context.params;
  return bracketHandlers.getBracket(request, organizationId, competitionId, bracketId);
}
