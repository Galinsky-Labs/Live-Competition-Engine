import * as judges from "@live-competition-engine/db/judges";
import { authService } from "../../../../../../../lib/services";
import { createJudgeHandlers } from "./handlers";

export const judgeHandlers = createJudgeHandlers(authService(), judges);
