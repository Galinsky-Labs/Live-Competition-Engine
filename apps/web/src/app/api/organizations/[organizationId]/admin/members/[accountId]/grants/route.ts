import { tenantAdminHandlers } from "@/lib/tenant-admin-services";

type Context = { params: Promise<{ organizationId: string; accountId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, accountId } = await context.params;
  return tenantAdminHandlers().grantRole(request, organizationId, accountId);
}
