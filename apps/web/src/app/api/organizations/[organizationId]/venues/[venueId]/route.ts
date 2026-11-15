import { tenantAdminHandlers } from "@/lib/tenant-admin-services";

type Context = { params: Promise<{ organizationId: string; venueId: string }> };

export async function PUT(request: Request, context: Context) {
  const { organizationId, venueId } = await context.params;
  return tenantAdminHandlers().updateVenue(request, organizationId, venueId);
}

export async function DELETE(request: Request, context: Context) {
  const { organizationId, venueId } = await context.params;
  return tenantAdminHandlers().archiveVenue(request, organizationId, venueId);
}
