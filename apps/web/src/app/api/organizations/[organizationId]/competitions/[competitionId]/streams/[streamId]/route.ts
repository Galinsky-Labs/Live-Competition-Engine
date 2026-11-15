import { createMuxProviderFromEnv } from "@live-competition-engine/db/providers/mux";
import * as streams from "@live-competition-engine/db/streams";
import { authService } from "../../../../../../../../lib/services";
import { createStreamHandlers } from "../handler";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string; streamId: string }> };

const handlers = () => createStreamHandlers(authService(), { ...streams, provider: () => createMuxProviderFromEnv() });

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId, streamId } = await context.params;
  return handlers().get(request, organizationId, competitionId, streamId);
}

/** POST {action: "recreate"|"reset_key"|"end"|"publish"|"unpublish"} */
export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId, streamId } = await context.params;
  return handlers().act(request, organizationId, competitionId, streamId);
}
