import { notificationHandlers } from "@/lib/notification-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; notificationId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, notificationId } = await context.params;
  return notificationHandlers().markRead(request, organizationId, notificationId);
}
