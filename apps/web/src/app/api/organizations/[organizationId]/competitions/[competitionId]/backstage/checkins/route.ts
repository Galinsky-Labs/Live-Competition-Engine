import { backstageHandlers, type BackstageParams } from "../wiring";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: BackstageParams) {
  const { organizationId, competitionId } = await context.params;
  return backstageHandlers().checkin(request, organizationId, competitionId);
}
