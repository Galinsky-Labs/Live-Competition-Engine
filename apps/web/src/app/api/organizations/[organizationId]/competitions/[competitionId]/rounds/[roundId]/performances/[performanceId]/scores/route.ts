import { route } from "../../../../../../../../../../../lib/competition-endpoint";
import { scoringHandlers as h } from "../../../../../scoring/postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.getSheet);
export const PUT = route(h.saveSheet);
