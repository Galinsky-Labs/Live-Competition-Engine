import { authService, planAdminDeps } from "../../../../lib/saas-services";
import { createPlanAdminHandlers } from "./handler";

const handlers = createPlanAdminHandlers(authService(), planAdminDeps);

export const GET = (request: Request) => handlers.list(request);
export const POST = (request: Request) => handlers.create(request);
