import { controlRoomHandlers } from "../../../wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string; performanceId: string }> };

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId, performanceId } = await context.params;
  return controlRoomHandlers().performanceStatus(request, organizationId, competitionId, performanceId);
}
