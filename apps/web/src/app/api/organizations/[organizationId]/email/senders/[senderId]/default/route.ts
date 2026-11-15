import { whiteLabelEmailHandlers } from "@/lib/white-label-email-services";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; senderId: string }> };

export async function POST(request: Request, context: Context) {
  const { organizationId, senderId } = await context.params;
  return whiteLabelEmailHandlers().defaultSender(request, organizationId, senderId);
}
