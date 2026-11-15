import { subscriptionHandlers } from "@/app/api/organizations/[organizationId]/membership-plans/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; subscriptionId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, subscriptionId } = await context.params;
  return subscriptionHandlers().cancel(request, organizationId, subscriptionId);
}
