import { backstageHandlers } from "../../../wiring";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string; cueId: string }> };

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId, cueId } = await context.params;
  return backstageHandlers().ack(request, organizationId, competitionId, cueId);
}
