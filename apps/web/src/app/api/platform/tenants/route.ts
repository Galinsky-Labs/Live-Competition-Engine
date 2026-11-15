import { authService, platformAdminDeps } from "../../../../lib/platform-services";
import { createPlatformAdminHandlers } from "./handler";

const handlers = createPlatformAdminHandlers(authService(), platformAdminDeps);

export async function GET(request: Request) {
  return handlers.listTenants(request);
}
