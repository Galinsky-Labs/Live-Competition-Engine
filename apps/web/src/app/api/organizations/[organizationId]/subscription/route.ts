import { authService, subscriptionDeps, tenantGuard } from "../../../../../lib/saas-services";
import { createSubscriptionHandlers } from "./handler";

const handlers = createSubscriptionHandlers(authService(), subscriptionDeps, tenantGuard);

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.get(request, organizationId);
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.start(request, organizationId);
}
