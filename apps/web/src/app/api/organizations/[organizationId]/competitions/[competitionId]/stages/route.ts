import { stageHandlers } from "./instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return stageHandlers.list(request, organizationId, competitionId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return stageHandlers.create(request, organizationId, competitionId);
}
