import { templateHandlers } from "../../../contest-templates/instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return templateHandlers.getApplied(request, organizationId, competitionId);
}

export async function PUT(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return templateHandlers.apply(request, organizationId, competitionId);
}
