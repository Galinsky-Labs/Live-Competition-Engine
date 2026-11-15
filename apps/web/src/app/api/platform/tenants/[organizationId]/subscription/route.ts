import { authService, subscriptionDeps } from "../../../../../../lib/saas-services";
import { createPlatformSubscriptionStatusHandler } from "../../../../organizations/[organizationId]/subscription/handler";

const post = createPlatformSubscriptionStatusHandler(authService(), subscriptionDeps);

export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return post(request, organizationId);
}
