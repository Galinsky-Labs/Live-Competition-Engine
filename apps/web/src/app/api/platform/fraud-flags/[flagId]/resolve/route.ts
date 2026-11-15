import { authService, platformAdminDeps } from "../../../../../../lib/platform-services";
import { createPlatformAdminHandlers } from "../../../tenants/handler";

const handlers = createPlatformAdminHandlers(authService(), platformAdminDeps);

export async function POST(request: Request, context: { params: Promise<{ flagId: string }> }) {
  const { flagId } = await context.params;
  return handlers.resolveFlag(request, flagId);
}
