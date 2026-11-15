import { templateHandlers } from "./instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  return templateHandlers.list(request, (await context.params).organizationId);
}

export async function POST(request: Request, context: Context) {
  return templateHandlers.create(request, (await context.params).organizationId);
}
