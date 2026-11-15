import { followHandlers } from "../instance";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  return followHandlers.consent(request, (await context.params).organizationId);
}
