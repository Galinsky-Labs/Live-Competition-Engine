import { notificationHandlers } from "@/lib/notification-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return notificationHandlers().send(request, organizationId);
}
