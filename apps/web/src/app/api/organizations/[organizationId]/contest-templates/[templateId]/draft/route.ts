import { templateHandlers } from "../../instance";

export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ organizationId: string; templateId: string }> }) {
  const { organizationId, templateId } = await context.params;
  return templateHandlers.saveDraft(request, organizationId, templateId);
}
