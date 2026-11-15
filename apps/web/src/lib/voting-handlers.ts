import * as voting from "@live-competition-engine/db/voting";
import { createVotingHandlers } from "../app/api/organizations/[organizationId]/competitions/[competitionId]/voting/handler";
import { authService } from "./services";

/** Voting (LC-28) handlers wired to the PostgreSQL services. */
export const votingHandlers = createVotingHandlers(authService(), voting);
