import { subscriptionHandlers } from "@/app/api/organizations/[organizationId]/membership-plans/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; planId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, planId } = await context.params;
  return subscriptionHandlers().archivePlan(request, organizationId, planId);
}
