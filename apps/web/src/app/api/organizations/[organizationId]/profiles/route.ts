import { profileHandlers } from "./instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return profileHandlers.list(request, organizationId);
}
