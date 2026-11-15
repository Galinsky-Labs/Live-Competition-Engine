import { moderationHandlers } from "@/lib/moderation-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; reportId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, reportId } = await context.params;
  return moderationHandlers().addEvidence(request, organizationId, reportId);
}
