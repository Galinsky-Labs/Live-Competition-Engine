import { route } from "../../../../../../../../lib/competition-endpoint";
import { judgeHandlers as h } from "../../judges/postgres";

export const dynamic = "force-dynamic";
export const POST = route(h.declareConflict);
