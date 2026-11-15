import { route } from "../../../../../../../../../lib/competition-endpoint";
import { selectionHandlers as h } from "../../../selection/postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.getPanel);
export const POST = route(h.assignJudge);
export const DELETE = route(h.removeJudge);
