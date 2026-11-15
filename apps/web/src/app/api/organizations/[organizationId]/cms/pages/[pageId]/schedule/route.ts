import { cmsHandlers } from "@/lib/cms-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; pageId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, pageId } = await context.params;
  return cmsHandlers().schedule(request, organizationId, pageId);
}

export async function DELETE(request: Request, context: Context) {
  const { organizationId, pageId } = await context.params;
  return cmsHandlers().cancelSchedule(request, organizationId, pageId);
}
