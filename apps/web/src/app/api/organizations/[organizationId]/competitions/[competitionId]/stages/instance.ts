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
    decideAdvancement(organizationId, competitionId, stageId, actorAccountId, input),
  getDecision: getAdvancement
});
