import { tipHandlers } from "@/app/api/organizations/[organizationId]/competitions/[competitionId]/tips/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return tipHandlers().listGifts(request, organizationId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return tipHandlers().createGift(request, organizationId);
}
