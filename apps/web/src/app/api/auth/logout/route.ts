import { authorizationHeader, clearSessionCookie, route } from "@/lib/http";
import { getAuth, secureCookies } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  const header = authorizationHeader(request);
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) await getAuth().revoke(token);
  const response = new Response(null, { status: 204 });
  response.headers.append("set-cookie", clearSessionCookie(secureCookies()));
  return response;
});
