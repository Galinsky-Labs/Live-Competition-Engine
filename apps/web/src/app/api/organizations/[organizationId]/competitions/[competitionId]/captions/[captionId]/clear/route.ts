import * as broadcast from "@live-competition-engine/db/broadcast";
import { authService } from "../../../../../../../../../lib/services";
import { createCaptionHandlers } from "../../handler";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string; captionId: string }> };

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId, captionId } = await context.params;
  return createCaptionHandlers(authService(), {
    listActiveCaptions: (o, c) => broadcast.listActiveCaptions(o, c),
    setCaption: broadcast.setCaption,
    clearCaption: broadcast.clearCaption
  }).clear(request, organizationId, competitionId, captionId);
}
