import { authService, platformAdminDeps } from "../../../../../lib/platform-services";
import { createPlatformAdminHandlers } from "../../../platform/tenants/handler";

const handlers = createPlatformAdminHandlers(authService(), platformAdminDeps);

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.tenantAnnouncements(request, organizationId);
}
