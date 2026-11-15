import { route } from "../../../../../../../../lib/competition-endpoint";
import { critiqueHandlers as h } from "../../critiques/postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.judgeList);
