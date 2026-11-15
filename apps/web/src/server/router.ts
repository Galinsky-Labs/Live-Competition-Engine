import { HttpError, readJsonObject, requireUuid, toErrorResponse } from "@/lib/http";

export interface RouteContext {
  request: Request;
  url: URL;
  organizationId: string;
  params: Record<string, string>;
  body: () => Promise<Record<string, unknown>>;
}

export interface RouteDef {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below `/api/organizations/{organizationId}/events`, e.g. "", ":eventId", ":eventId/publish". */
  pattern: string;
  handler: (ctx: RouteContext) => Promise<Response>;
}

function match(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern === "" ? [] : pattern.split("/");
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const segment = segments[i]!;
    if (part.startsWith(":")) {
      // Every dynamic segment in this API is a UUID.
      params[part.slice(1)] = requireUuid(segment, `invalid_${part.slice(1)}`);
    } else if (part !== segment) return null;
  }
  return params;
}

export function createRouter(routes: RouteDef[]) {
  return async function dispatch(request: Request, organizationIdRaw: string, segments: string[]): Promise<Response> {
    try {
      const organizationId = requireUuid(organizationIdRaw, "invalid_organization");
      let methodMismatch = false;
      for (const route of routes) {
        let params: Record<string, string> | null;
        try {
          params = match(route.pattern, segments);
        } catch (error) {
          if (error instanceof HttpError) continue;
          throw error;
        }
        if (!params) continue;
        if (route.method !== request.method) {
          methodMismatch = true;
          continue;
        }
        let cached: Promise<Record<string, unknown>> | undefined;
        return await route.handler({
          request,
          url: new URL(request.url),
          organizationId,
          params,
          body: () => (cached ??= readJsonObject(request))
        });
      }
      return Response.json({ error: methodMismatch ? "method_not_allowed" : "not_found" }, { status: methodMismatch ? 405 : 404 });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

export const json = (data: unknown, status = 200) => Response.json(data, { status });
