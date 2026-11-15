import { whiteLabelEmailHandlers } from "@/lib/white-label-email-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; templateId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, templateId } = await context.params;
  return whiteLabelEmailHandlers().addVersion(request, organizationId, templateId);
}
