import { CredentialError } from "@live-competition-engine/auth/credentials";
import { errorResponse, readJsonObject, route, sessionCookie } from "@/lib/http";
import { getCredentials, secureCookies } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  const body = await readJsonObject(request, 4096);
  try {
    const result = await getCredentials().signUp(body.email, body.password);
    const response = Response.json(
      { accountId: result.accountId, expiresAt: result.session.expiresAt, ...(body.mode === "token" ? { token: result.token } : {}) },
      { status: 201 }
    );
    response.headers.append("set-cookie", sessionCookie(result.token, result.session.expiresAt, secureCookies()));
    return response;
  } catch (error) {
    if (error instanceof CredentialError) return errorResponse(error.code === "email_taken" ? 409 : 400, error.code);
    throw error;
  }
});
