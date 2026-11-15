import { tenantAdminHandlers } from "@/lib/tenant-admin-services";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return tenantAdminHandlers().listVenues(request, organizationId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return tenantAdminHandlers().createVenue(request, organizationId);
}
