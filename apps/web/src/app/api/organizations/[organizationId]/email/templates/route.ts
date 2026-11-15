import { whiteLabelEmailHandlers } from "@/lib/white-label-email-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return whiteLabelEmailHandlers().listTemplates(request, organizationId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return whiteLabelEmailHandlers().createTemplate(request, organizationId);
}
