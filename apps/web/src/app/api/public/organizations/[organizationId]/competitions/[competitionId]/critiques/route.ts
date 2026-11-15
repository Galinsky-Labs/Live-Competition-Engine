import { route } from "../../../../../../../../lib/competition-endpoint";
import { publicCritiquesHandler } from "../../../../../../organizations/[organizationId]/competitions/[competitionId]/critiques/postgres";

export const dynamic = "force-dynamic";
export const GET = route(publicCritiquesHandler);
