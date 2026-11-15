import { dispatchEventApi } from "@/server/api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ organizationId: string; path?: string[] }> };

const handle = async (request: Request, context: Context) => {
  const { organizationId, path } = await context.params;
  return dispatchEventApi(request, organizationId, path ?? []);
};

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
