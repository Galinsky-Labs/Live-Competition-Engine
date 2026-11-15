import { eventHandlers } from "../../../../organizations/[organizationId]/competitions/instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  return eventHandlers.publicList(request, (await context.params).organizationId);
}
