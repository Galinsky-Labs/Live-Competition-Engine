import { authService, planAdminDeps } from "../../../../../../lib/saas-services";
import { createPlanAdminHandlers } from "../../handler";

const handlers = createPlanAdminHandlers(authService(), planAdminDeps);

export async function POST(request: Request, context: { params: Promise<{ planId: string }> }) {
  const { planId } = await context.params;
  return handlers.transition(request, planId, "publish");
}
