import { profileHandlers } from "../../instance";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; profileId: string }> }) {
  const { organizationId, profileId } = await context.params;
  return profileHandlers.moderate(request, organizationId, profileId);
}
