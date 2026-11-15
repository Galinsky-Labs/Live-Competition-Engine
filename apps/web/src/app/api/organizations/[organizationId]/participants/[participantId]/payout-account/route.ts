import { tipHandlers } from "@/app/api/organizations/[organizationId]/competitions/[competitionId]/tips/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; participantId: string }> };

export async function PUT(request: Request, context: Context) {
  const { organizationId, participantId } = await context.params;
  return tipHandlers().linkPayout(request, organizationId, participantId);
}
