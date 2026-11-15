import { cmsHandlers } from "@/lib/cms-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return cmsHandlers().listPages(request, organizationId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return cmsHandlers().createPage(request, organizationId);
}
