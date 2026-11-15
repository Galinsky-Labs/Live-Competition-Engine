import { tenantAdminHandlers } from "@/lib/tenant-admin-services";

type Context = { params: Promise<{ organizationId: string; invitationId: string }> };

export async function DELETE(request: Request, context: Context) {
  const { organizationId, invitationId } = await context.params;
  return tenantAdminHandlers().revokeInvitation(request, organizationId, invitationId);
}
