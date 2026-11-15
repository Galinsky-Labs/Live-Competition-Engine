import * as backstage from "@live-competition-engine/db/backstage";
import { getRunOfShow } from "@live-competition-engine/db/run-of-show";
import { authService } from "../../../../../../../lib/services";
import { createBackstageHandlers } from "./handler";

export type BackstageParams = { params: Promise<{ organizationId: string; competitionId: string }> };

let handlers: ReturnType<typeof createBackstageHandlers> | undefined;
export function backstageHandlers() {
  handlers ??= createBackstageHandlers(authService(), { ...backstage, getRunOfShow: (o, c) => getRunOfShow(o, c) });
  return handlers;
}
