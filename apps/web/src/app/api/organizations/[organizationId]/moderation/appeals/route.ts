import { moderationHandlers } from "@/lib/moderation-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return moderationHandlers().listAppeals(request, organizationId);
}
