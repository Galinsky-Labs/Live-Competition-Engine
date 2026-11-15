import { notificationHandlers } from "@/lib/notification-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return notificationHandlers().getPreferences(request, organizationId);
}

export async function PUT(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return notificationHandlers().setPreferences(request, organizationId);
}
