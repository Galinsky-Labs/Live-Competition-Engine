import { controlRoomHandlers } from "../wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return controlRoomHandlers().createRound(request, organizationId, competitionId);
}
