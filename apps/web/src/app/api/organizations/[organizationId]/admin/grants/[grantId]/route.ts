import { tenantAdminHandlers } from "@/lib/tenant-admin-services";

type Context = { params: Promise<{ organizationId: string; grantId: string }> };

export async function DELETE(request: Request, context: Context) {
  const { organizationId, grantId } = await context.params;
  return tenantAdminHandlers().revokeRole(request, organizationId, grantId);
}
