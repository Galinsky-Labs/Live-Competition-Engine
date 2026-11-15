import { authService, platformAdminDeps } from "../../../../lib/platform-services";
import { createPlatformAdminHandlers } from "../tenants/handler";

const handlers = createPlatformAdminHandlers(authService(), platformAdminDeps);

export async function POST(request: Request) {
  return handlers.stepUp(request);
}

export async function DELETE(request: Request) {
  return handlers.revokeStepUp(request);
}
