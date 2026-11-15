import { controlRoomHandlers } from "../../../wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string; roundId: string }> };

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId, roundId } = await context.params;
  return controlRoomHandlers().roundStatus(request, organizationId, competitionId, roundId);
}
