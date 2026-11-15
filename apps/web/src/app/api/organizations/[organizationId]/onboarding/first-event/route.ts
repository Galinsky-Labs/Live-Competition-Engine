import { authService, onboardingDeps } from "../../../../../../lib/signup-services";
import { createOnboardingHandlers } from "../handler";

const handlers = createOnboardingHandlers(authService(), onboardingDeps);

export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.firstEvent(request, organizationId);
}
