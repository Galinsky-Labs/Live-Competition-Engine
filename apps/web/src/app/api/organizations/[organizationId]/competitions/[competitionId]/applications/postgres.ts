import * as applications from "@live-competition-engine/db/applications";
import { authService } from "../../../../../../../lib/services";
import { createApplicationHandlers } from "./handlers";

/** Production wiring: PostgreSQL services + session authentication. */
export const applicationHandlers = createApplicationHandlers(authService(), applications);
