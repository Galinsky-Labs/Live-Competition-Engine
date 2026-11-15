import { createMuxProviderFromEnv } from "@live-competition-engine/db/providers/mux";
import * as streams from "@live-competition-engine/db/streams";
import { authService } from "../../../../../../../lib/services";
import { createStreamHandlers } from "./handler";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string }> };

const handlers = () => createStreamHandlers(authService(), { ...streams, provider: () => createMuxProviderFromEnv() });

export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return handlers().list(request, organizationId, competitionId);
}

export async function POST(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  return handlers().create(request, organizationId, competitionId);
}
