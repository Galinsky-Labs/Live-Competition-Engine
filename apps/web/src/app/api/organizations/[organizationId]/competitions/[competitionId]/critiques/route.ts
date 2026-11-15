import { route } from "../../../../../../../lib/competition-endpoint";
import { critiqueHandlers as h } from "./postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.queue);
