import { paymentHandlers } from "@/app/api/organizations/[organizationId]/payments/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; orderId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, orderId } = await context.params;
  return paymentHandlers().getOrder(request, organizationId, orderId);
}
