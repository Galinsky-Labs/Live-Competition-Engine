import { splitHandlers } from "@/app/api/organizations/[organizationId]/revenue-splits/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; orderId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, orderId } = await context.params;
  return splitHandlers().adjust(request, organizationId, orderId);
}
