import { authService, platformAdminDeps } from "../../../../lib/platform-services";
import { createPlatformAdminHandlers } from "../tenants/handler";

const handlers = createPlatformAdminHandlers(authService(), platformAdminDeps);

export async function GET(request: Request) {
  return handlers.listFlags(request);
}

export async function POST(request: Request) {
  return handlers.raiseFlag(request);
}
