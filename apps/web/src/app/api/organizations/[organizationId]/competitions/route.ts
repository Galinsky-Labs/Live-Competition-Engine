import { eventHandlers } from "./instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  return eventHandlers.list(request, (await context.params).organizationId);
}

export async function POST(request: Request, context: Context) {
  return eventHandlers.create(request, (await context.params).organizationId);
}
