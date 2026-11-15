import type { SignupResult } from "@live-competition-engine/db/tenant-signup";
import { authFailure, domainFailure, errorResponse, json, readJsonObject, type Authorizer } from "../../../lib/http";

export interface SignupHandlerDeps {
  signup(input: unknown, ipHash: string): Promise<SignupResult>;
  checkSlug(slug: unknown): Promise<{ available: boolean; slug?: string; reason?: string }>;
  verifyEmail(accountId: unknown, token: unknown): Promise<{ accountId: string; verifiedAt: Date }>;
  resend(accountId: string): Promise<{ expiresAt: Date; delivered: boolean; testToken?: string }>;
  hashIp(ip: string): string;
}

const signupStatus = {
  email_unavailable: 409,
  slug_unavailable: 409,
  plan_not_found: 400,
  email_already_verified: 409,
  account_not_found: 401
};

/**
 * Client address for rate limiting. Assumes the deployment's reverse proxy sets
 * X-Forwarded-For (first hop = client). Without it every caller shares one bucket (fail closed).
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && forwarded.length <= 64) return forwarded;
  const real = request.headers.get("x-real-ip")?.trim();
  if (real && real.length <= 64) return real;
  return "unknown";
}

/** LC-50 public signup API. Identity for resend comes from the bearer session only. */
export function createSignupHandlers(authorizer: Pick<Authorizer, "authorize">, deps: SignupHandlerDeps) {
  return {
    async signup(request: Request): Promise<Response> {
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      try {
        const result = await deps.signup(body, deps.hashIp(clientIp(request)));
        return json(result, 201);
      } catch (error) {
        return domainFailure(error, signupStatus);
      }
    },

    async slugAvailability(request: Request): Promise<Response> {
      const slug = new URL(request.url).searchParams.get("slug");
      if (slug === null || slug.length > 100) return errorResponse(400, "invalid_slug");
      return json(await deps.checkSlug(slug));
    },

    async verify(request: Request): Promise<Response> {
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      try {
        return json(await deps.verifyEmail(body.accountId, body.token));
      } catch (error) {
        return domainFailure(error);
      }
    },

    async resend(request: Request): Promise<Response> {
      let principal;
      try {
        principal = await authorizer.authorize(request.headers.get("authorization"));
      } catch (error) {
        return authFailure(error);
      }
      try {
        return json(await deps.resend(principal.accountId), 202);
      } catch (error) {
        return domainFailure(error, signupStatus);
      }
    }
  };
}
