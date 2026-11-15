import { cmsHandlers } from "@/lib/cms-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; pageId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, pageId } = await context.params;
  return cmsHandlers().publish(request, organizationId, pageId);
}
