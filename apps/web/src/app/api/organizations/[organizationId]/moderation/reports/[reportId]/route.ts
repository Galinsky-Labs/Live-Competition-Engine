import { moderationHandlers } from "@/lib/moderation-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; reportId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, reportId } = await context.params;
  return moderationHandlers().getReport(request, organizationId, reportId);
}

export async function DELETE(request: Request, context: Context) {
  const { organizationId, reportId } = await context.params;
  return moderationHandlers().deleteReport(request, organizationId, reportId);
}
