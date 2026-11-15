import * as scoring from "@live-competition-engine/db/scoring";
import { authService } from "../../../../../../../lib/services";
import { createScoringHandlers } from "./handlers";

export const scoringHandlers = createScoringHandlers(authService(), scoring);
