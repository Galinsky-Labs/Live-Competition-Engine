import { route } from "../../../../../../../lib/competition-endpoint";
import { selectionHandlers as h } from "./postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.summary);
