import { CredentialError } from "@live-competition-engine/auth/credentials";
import { errorResponse, readJsonObject, route, sessionCookie } from "@/lib/http";
import { getCredentials, secureCookies } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  const body = await readJsonObject(request, 4096);
  try {
    const result = await getCredentials().login(body.email, body.password);
    const response = Response.json({
      accountId: result.accountId,
      expiresAt: result.session.expiresAt,
      ...(body.mode === "token" ? { token: result.token } : {})
    });
    response.headers.append("set-cookie", sessionCookie(result.token, result.session.expiresAt, secureCookies()));
    return response;
  } catch (error) {
    if (error instanceof CredentialError && error.code === "throttled") {
      return new Response(JSON.stringify({ error: "throttled" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "900" } });
    }
    if (error instanceof CredentialError) return errorResponse(400, error.code);
    throw error;
  }
});
