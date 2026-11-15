import { createRouter, type RouteDef } from "./router";
import { eventRoutes } from "./routes/events";
import { stageRoutes } from "./routes/stages";

/** All event-scoped routes. Units register their route tables here. */
export const routes: RouteDef[] = [...eventRoutes, ...stageRoutes];

export const dispatchEventApi = createRouter(routes);
