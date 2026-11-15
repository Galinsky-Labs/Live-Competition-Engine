import { blockedTermHandlers } from "../../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ organizationId: string; termId: string }> }) {
  const { organizationId, termId } = await context.params;
  return blockedTermHandlers.remove(request, organizationId, termId);
}
