import { moderationHandlers } from "@/lib/moderation-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; appealId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, appealId } = await context.params;
  return moderationHandlers().decideAppeal(request, organizationId, appealId);
}
