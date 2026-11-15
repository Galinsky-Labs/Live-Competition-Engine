import * as voting from "@live-competition-engine/db/voting";
import * as integrity from "@live-competition-engine/db/voting-integrity";
import { createVotingHandlers } from "../app/api/organizations/[organizationId]/competitions/[competitionId]/voting/handler";
import { createIntegrityHandlers } from "../app/api/organizations/[organizationId]/competitions/[competitionId]/voting/integrity-handler";
import { authService } from "./services";

/** Voting (LC-28) handlers wired to the PostgreSQL services. */
export const votingHandlers = createVotingHandlers(authService(), voting);
/** Voting integrity (LC-29) handlers wired to the PostgreSQL services. */
export const integrityHandlers = createIntegrityHandlers(authService(), integrity);
