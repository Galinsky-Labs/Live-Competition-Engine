import { profileHandlers } from "../../../../organizations/[organizationId]/profiles/instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return profileHandlers.publicList(request, organizationId);
}
