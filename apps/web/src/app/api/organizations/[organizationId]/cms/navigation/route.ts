import { cmsHandlers } from "@/lib/cms-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return cmsHandlers().getNavigation(request, organizationId);
}

export async function PUT(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return cmsHandlers().setNavigation(request, organizationId);
}
