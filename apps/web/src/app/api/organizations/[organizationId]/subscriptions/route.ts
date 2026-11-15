import { subscriptionHandlers } from "@/app/api/organizations/[organizationId]/membership-plans/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return subscriptionHandlers().listMine(request, organizationId);
}
