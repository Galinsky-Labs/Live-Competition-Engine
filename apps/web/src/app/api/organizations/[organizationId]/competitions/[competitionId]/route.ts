import { eventHandlers } from "../instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return eventHandlers.get(request, organizationId, competitionId);
}

export async function PATCH(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return eventHandlers.update(request, organizationId, competitionId);
}
