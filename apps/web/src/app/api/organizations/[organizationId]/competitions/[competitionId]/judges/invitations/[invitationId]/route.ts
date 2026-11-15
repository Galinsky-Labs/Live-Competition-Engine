import { route } from "../../../../../../../../../lib/competition-endpoint";
import { judgeHandlers as h } from "../../postgres";

export const dynamic = "force-dynamic";
export const DELETE = route(h.revokeInvitation);
