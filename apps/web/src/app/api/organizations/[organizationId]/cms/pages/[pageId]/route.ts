import { cmsHandlers } from "@/lib/cms-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; pageId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, pageId } = await context.params;
  return cmsHandlers().getPage(request, organizationId, pageId);
}

export async function PUT(request: Request, context: Context) {
  const { organizationId, pageId } = await context.params;
  return cmsHandlers().updateDraft(request, organizationId, pageId);
}
