import { profileHandlers } from "../../../profiles/instance";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ organizationId: string; participantId: string }> }) {
  const { organizationId, participantId } = await context.params;
  return profileHandlers.linkParticipant(request, organizationId, participantId);
}
