import { authService, onboardingDeps } from "../../../../../lib/signup-services";
import { createOnboardingHandlers } from "./handler";

const handlers = createOnboardingHandlers(authService(), onboardingDeps);

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.get(request, organizationId);
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return handlers.skip(request, organizationId);
}
