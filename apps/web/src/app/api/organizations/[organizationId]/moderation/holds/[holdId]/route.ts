import { moderationHandlers } from "@/lib/moderation-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; holdId: string }> };

export async function DELETE(request: Request, context: Context) {
  const { organizationId, holdId } = await context.params;
  return moderationHandlers().releaseHold(request, organizationId, holdId);
}
