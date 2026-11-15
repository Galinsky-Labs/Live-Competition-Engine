import { stageHandlers } from "../../instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; competitionId: string; stageId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, competitionId, stageId } = await context.params;
  return stageHandlers.getDecision(request, organizationId, competitionId, stageId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId, competitionId, stageId } = await context.params;
  return stageHandlers.decide(request, organizationId, competitionId, stageId);
}
