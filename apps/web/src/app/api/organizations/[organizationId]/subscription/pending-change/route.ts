import { authService, subscriptionDeps, tenantGuard } from "../../../../../../lib/saas-services";
import { createSubscriptionHandlers } from "../handler";

const handlers = createSubscriptionHandlers(authService(), subscriptionDeps, tenantGuard);

export async function DELETE(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.cancelPendingChange(request, organizationId);
}
