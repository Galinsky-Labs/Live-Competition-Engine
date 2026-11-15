import { timerHandlers } from "../../wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string; timerId: string }> };

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId, timerId } = await context.params;
  return timerHandlers().log(request, organizationId, competitionId, timerId);
}

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId, timerId } = await context.params;
  return timerHandlers().command(request, organizationId, competitionId, timerId);
}
