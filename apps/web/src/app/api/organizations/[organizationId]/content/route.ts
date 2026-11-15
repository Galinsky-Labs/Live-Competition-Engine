import { contentHandlers } from "@/app/api/organizations/[organizationId]/content/services";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return contentHandlers().list(request, organizationId);
}

export async function POST(request: Request, context: Context) {
  const { organizationId } = await context.params;
  return contentHandlers().create(request, organizationId);
}
