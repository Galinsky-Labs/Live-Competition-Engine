import { tenantAdminHandlers } from "@/lib/tenant-admin-services";

type Context = { params: Promise<{ organizationId: string; competitionId: string }> };

export async function PUT(request: Request, context: Context) {
  const { organizationId, competitionId } = await context.params;
  return tenantAdminHandlers().assignVenue(request, organizationId, competitionId);
}
