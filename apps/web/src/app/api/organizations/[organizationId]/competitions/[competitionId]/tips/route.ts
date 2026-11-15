import { tipHandlers } from "@/app/api/organizations/[organizationId]/competitions/[competitionId]/tips/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return tipHandlers().feed(request, organizationId, competitionId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return tipHandlers().send(request, organizationId, competitionId);
}
