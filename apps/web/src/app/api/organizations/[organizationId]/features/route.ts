import { featureControlHandlers } from "@/lib/feature-control-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return featureControlHandlers().tenantEffective(request, organizationId);
}

export async function PUT(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return featureControlHandlers().tenantSet(request, organizationId);
}
