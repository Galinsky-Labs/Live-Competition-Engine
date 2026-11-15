import { contentHandlers } from "@/app/api/organizations/[organizationId]/content/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; itemId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, itemId } = await context.params;
  return contentHandlers().purchase(request, organizationId, itemId);
}
