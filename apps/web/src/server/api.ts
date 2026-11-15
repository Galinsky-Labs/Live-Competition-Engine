import { createRouter, type RouteDef } from "./router";
import { eventRoutes } from "./routes/events";
import { stageRoutes } from "./routes/stages";
import { registrationRoutes } from "./routes/registration";
import { judgingRoutes } from "./routes/judging";
import { streamBackstageRoutes } from "./routes/streams-backstage";
import { controlRoomRoutes } from "./routes/control-room";
import { audienceVotingRoutes } from "./routes/audience-voting";

/** All event-scoped routes. Units register their route tables here. */
export const routes: RouteDef[] = [...eventRoutes, ...stageRoutes, ...registrationRoutes, ...judgingRoutes, ...streamBackstageRoutes, ...controlRoomRoutes, ...audienceVotingRoutes];

export const dispatchEventApi = createRouter(routes);
