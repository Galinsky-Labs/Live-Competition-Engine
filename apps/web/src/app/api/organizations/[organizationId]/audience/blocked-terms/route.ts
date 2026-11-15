import { blockedTermHandlers } from "../../../../../../lib/audience-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return blockedTermHandlers.list(request, organizationId);
}

export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return blockedTermHandlers.add(request, organizationId);
}
