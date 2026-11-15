import { cmsHandlers } from "@/lib/cms-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; slug: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, slug } = await context.params;
  return cmsHandlers().publicPage(request, organizationId, slug);
}
