import { splitHandlers } from "@/app/api/organizations/[organizationId]/revenue-splits/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return splitHandlers().list(request, organizationId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return splitHandlers().create(request, organizationId);
}
