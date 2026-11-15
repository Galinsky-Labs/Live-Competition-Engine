import { tipHandlers } from "@/app/api/organizations/[organizationId]/competitions/[competitionId]/tips/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return tipHandlers().quote(request, organizationId, competitionId);
}
