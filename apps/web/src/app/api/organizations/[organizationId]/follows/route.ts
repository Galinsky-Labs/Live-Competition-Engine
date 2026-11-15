import { followHandlers } from "./instance";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string }> };

export async function GET(request: Request, context: Context) {
  return followHandlers.list(request, (await context.params).organizationId);
}

export async function POST(request: Request, context: Context) {
  return followHandlers.follow(request, (await context.params).organizationId);
}

export async function DELETE(request: Request, context: Context) {
  return followHandlers.unfollow(request, (await context.params).organizationId);
}
