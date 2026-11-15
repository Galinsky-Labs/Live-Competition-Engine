import { whiteLabelEmailHandlers } from "@/lib/white-label-email-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; messageId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId, messageId } = await context.params;
  return whiteLabelEmailHandlers().trace(request, organizationId, messageId);
}
