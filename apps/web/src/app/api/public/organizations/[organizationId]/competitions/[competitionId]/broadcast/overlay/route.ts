import { getPublicOverlay, getPublicScoreboard } from "@live-competition-engine/db/broadcast";
import { createPublicBroadcastHandlers } from "../handler";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string }> };

const handlers = createPublicBroadcastHandlers({ getPublicOverlay, getPublicScoreboard });

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return handlers.overlay(request, organizationId, competitionId);
}
