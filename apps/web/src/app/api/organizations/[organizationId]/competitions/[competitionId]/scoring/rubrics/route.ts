import { route } from "../../../../../../../../lib/competition-endpoint";
import { scoringHandlers as h } from "../postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.listRubrics);
export const POST = route(h.createRubric);
