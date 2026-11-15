import { timerHandlers } from "./wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return timerHandlers().list(request, organizationId, competitionId);
}

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return timerHandlers().create(request, organizationId, competitionId);
}
