import { backstageHandlers, type BackstageParams } from "../wiring";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: BackstageParams) {
  const { organizationId, competitionId } = await context.params;
  return backstageHandlers().messages(request, organizationId, competitionId);
}
