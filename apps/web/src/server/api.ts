import { createRouter, type RouteDef } from "./router";
import { eventRoutes } from "./routes/events";

/** All event-scoped routes. Units register their route tables here. */
export const routes: RouteDef[] = [...eventRoutes];

export const dispatchEventApi = createRouter(routes);
