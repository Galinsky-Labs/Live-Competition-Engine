import { integrityHandlers } from "../../../../../../../../../../lib/voting-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; windowId: string }> }) {
  const { organizationId, competitionId, windowId } = await context.params;
  return integrityHandlers.listAnomalies(request, { organizationId, competitionId }, windowId);
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; competitionId: string; windowId: string }> }) {
  const { organizationId, competitionId, windowId } = await context.params;
  return integrityHandlers.postAnomalyScan(request, { organizationId, competitionId }, windowId);
}
