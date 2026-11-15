import { profileHandlers } from "../instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; profileId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, profileId } = await context.params;
  return profileHandlers.get(request, organizationId, profileId);
}

export async function PUT(request: Request, context: Context) {
  const { organizationId, profileId } = await context.params;
  return profileHandlers.put(request, organizationId, profileId);
}
