import { route } from "../../../../../../../../lib/competition-endpoint";
import { applicationHandlers as h } from "../postgres";

export const dynamic = "force-dynamic";
export const GET = route(h.getForm);
export const PUT = route(h.putForm);
