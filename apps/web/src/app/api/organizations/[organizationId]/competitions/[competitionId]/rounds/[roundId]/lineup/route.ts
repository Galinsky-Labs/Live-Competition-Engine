import { route } from "../../../../../../../../../lib/competition-endpoint";
import { selectionHandlers as h } from "../../../selection/postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.getLineup);
export const PUT = route(h.putLineup);
