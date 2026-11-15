import { authService, subscriptionDeps, tenantGuard } from "../../../../../../lib/saas-services";
import { createSubscriptionHandlers } from "../handler";

const handlers = createSubscriptionHandlers(authService(), subscriptionDeps, tenantGuard);

export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.cancel(request, organizationId);
}
