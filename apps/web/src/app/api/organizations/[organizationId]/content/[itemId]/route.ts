import { contentHandlers } from "@/app/api/organizations/[organizationId]/content/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string; itemId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, itemId } = await context.params;
  return contentHandlers().get(request, organizationId, itemId);
}
