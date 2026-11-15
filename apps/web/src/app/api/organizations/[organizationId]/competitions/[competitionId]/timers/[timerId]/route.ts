import { timerHandlers } from "../wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string; timerId: string }> };

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId, timerId } = await context.params;
  return timerHandlers().get(request, organizationId, competitionId, timerId);
}
