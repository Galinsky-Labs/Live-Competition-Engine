import { profileHandlers } from "../../../../../organizations/[organizationId]/profiles/instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; profileId: string }> }) {
  const { organizationId, profileId } = await context.params;
  return profileHandlers.publicGet(request, organizationId, profileId);
}
