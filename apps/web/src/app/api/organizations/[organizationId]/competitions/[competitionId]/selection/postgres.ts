import * as selection from "@live-competition-engine/db/selection";
import { authService } from "../../../../../../../lib/services";
import { createSelectionHandlers } from "./handlers";

export const selectionHandlers = createSelectionHandlers(authService(), selection);
