import { authService, subscriptionDeps, tenantGuard } from "../../../../../lib/saas-services";
import { createSubscriptionHandlers } from "../subscription/handler";

const handlers = createSubscriptionHandlers(authService(), subscriptionDeps, tenantGuard);

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.usage(request, organizationId);
}
