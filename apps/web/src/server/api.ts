import { createRouter, type RouteDef } from "./router";
import { eventRoutes } from "./routes/events";
import { stageRoutes } from "./routes/stages";
import { registrationRoutes } from "./routes/registration";
import { judgingRoutes } from "./routes/judging";
import { streamBackstageRoutes } from "./routes/streams-backstage";

/** All event-scoped routes. Units register their route tables here. */
export const routes: RouteDef[] = [...eventRoutes, ...stageRoutes, ...registrationRoutes, ...judgingRoutes, ...streamBackstageRoutes];

export const dispatchEventApi = createRouter(routes);
