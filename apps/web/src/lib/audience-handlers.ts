import * as audience from "@live-competition-engine/db/audience";
import { createAudienceHandlers, createBlockedTermHandlers } from "../app/api/organizations/[organizationId]/competitions/[competitionId]/audience/handler";
import { authService } from "./services";

/** Audience (LC-27) handlers wired to the PostgreSQL services. */
export const audienceHandlers = createAudienceHandlers(authService(), audience);
export const blockedTermHandlers = createBlockedTermHandlers(authService(), audience);
