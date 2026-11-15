import { route } from "../../../../../../../../../../lib/competition-endpoint";
import { scoringHandlers as h } from "../../../postgres";

export const dynamic = "force-dynamic";
export const POST = route(h.decideCorrection);
