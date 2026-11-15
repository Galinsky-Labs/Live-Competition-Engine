import { followHandlers } from "../instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  return followHandlers.count(request, (await context.params).organizationId);
}
