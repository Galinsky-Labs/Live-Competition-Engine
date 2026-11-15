import { controlRoomHandlers } from "./wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return controlRoomHandlers().view(request, organizationId, competitionId);
}
