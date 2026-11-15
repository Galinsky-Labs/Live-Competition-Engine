import { paymentHandlers } from "@/app/api/organizations/[organizationId]/payments/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return paymentHandlers().reconcile(request, organizationId);
}
