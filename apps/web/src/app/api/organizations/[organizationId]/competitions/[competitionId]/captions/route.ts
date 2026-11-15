import * as broadcast from "@live-competition-engine/db/broadcast";
import { authService } from "../../../../../../../lib/services";
import { createCaptionHandlers } from "./handler";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string }> };

const handlers = () => createCaptionHandlers(authService(), {
  listActiveCaptions: (o, c) => broadcast.listActiveCaptions(o, c),
  setCaption: broadcast.setCaption,
  clearCaption: broadcast.clearCaption
});

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return handlers().list(request, organizationId, competitionId);
}

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return handlers().set(request, organizationId, competitionId);
}
