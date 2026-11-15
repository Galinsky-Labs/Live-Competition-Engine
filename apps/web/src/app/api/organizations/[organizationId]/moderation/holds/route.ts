import { moderationHandlers } from "@/lib/moderation-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return moderationHandlers().placeHold(request, organizationId);
}
