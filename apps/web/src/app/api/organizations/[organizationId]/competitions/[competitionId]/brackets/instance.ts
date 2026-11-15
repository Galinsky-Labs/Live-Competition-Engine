import { isMatchAction } from "@live-competition-engine/domain/brackets";
import {
  actOnMatch,
  createBracket,
  createMatch,
  createTeam,
  getBracket,
  getPublicBracket,
  listBrackets,
  listTeams
} from "@live-competition-engine/db/brackets";
import { authService } from "../../../../../../../lib/services";
import { createBracketHandlers } from "./handler";

export const bracketHandlers = createBracketHandlers(authService(), {
  createTeam,
  listTeams,
  createBracket,
  listBrackets,
  getBracket,
  getPublicBracket,
  createMatch,
  actOnMatch,
  isAction: isMatchAction
});
