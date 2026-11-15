import { templateHandlers } from "../../instance";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ organizationId: string; templateId: string }> }) {
  const { organizationId, templateId } = await context.params;
  return templateHandlers.publish(request, organizationId, templateId);
}
