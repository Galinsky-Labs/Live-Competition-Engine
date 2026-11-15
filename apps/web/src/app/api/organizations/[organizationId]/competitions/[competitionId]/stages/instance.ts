import { bracketWinnersForStage } from "@live-competition-engine/db/brackets";
import {
  createStage,
  decideAdvancement,
  getAdvancement,
  listStages,
  reorderStages,
  updateStage
} from "@live-competition-engine/db/stages";
import { authService } from "../../../../../../../lib/services";
import { createStageHandlers } from "./handler";

export const stageHandlers = createStageHandlers(authService(), {
  list: listStages,
  create: createStage,
  update: updateStage,
  reorder: reorderStages,
  decide: (organizationId, competitionId, stageId, actorAccountId, input) =>
    // Bracket contracts resolve the champion of the stage's (optional, LC-16) bracket.
    decideAdvancement(organizationId, competitionId, stageId, actorAccountId, input, { bracketWinners: bracketWinnersForStage }),
  getDecision: getAdvancement
});
