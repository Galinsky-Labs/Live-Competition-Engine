import { isUuid } from "@live-competition-engine/domain";
import { getPublicStreamEmbed } from "@live-competition-engine/db/streams";
import { publicJson, publicNotFound } from "../../../../../../../../lib/live-http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationId: string; competitionId: string }> };

/** Anonymous embed info: `{ stream: { status, playbackId, live } }` only for a published stream. */
export async function GET(request: Request, context: Params) {
  const { organizationId, competitionId } = await context.params;
  if (!isUuid(organizationId) || !isUuid(competitionId)) return publicNotFound();
  const stream = await getPublicStreamEmbed(organizationId, competitionId);
  if (!stream) return publicNotFound();
  return publicJson(request, { stream }, {}, { maxAgeSeconds: 5 });
}
