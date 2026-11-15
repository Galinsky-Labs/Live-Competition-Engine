import * as critiques from "@live-competition-engine/db/critiques";
import { authService } from "../../../../../../../lib/services";
import { createCritiqueHandlers, createPublicCritiquesHandler } from "./handlers";

export const critiqueHandlers = createCritiqueHandlers(authService(), critiques);
export const publicCritiquesHandler = createPublicCritiquesHandler(critiques);
