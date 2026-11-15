import { moderationHandlers } from "@/lib/moderation-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; actionId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, actionId } = await context.params;
  return moderationHandlers().fileAppeal(request, organizationId, actionId);
}
