import { tenantAdminHandlers } from "@/lib/tenant-admin-services";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return tenantAdminHandlers().listInvitations(request, organizationId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return tenantAdminHandlers().createInvitation(request, organizationId);
}
