import { templateHandlers } from "../instance";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ organizationId: string; templateId: string }> }) {
  const { organizationId, templateId } = await context.params;
  return templateHandlers.get(request, organizationId, templateId);
}
