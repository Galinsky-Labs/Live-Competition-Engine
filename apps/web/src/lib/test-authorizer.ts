import { AuthenticationError } from "@live-competition-engine/auth";
import type { Authorizer } from "./http";

/** Test-only authorizer doubles for handler unit tests. Never import from production code. */
export const TEST_ORG = "11111111-1111-4111-8111-111111111111";
export const TEST_OTHER_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_ACCOUNT = "33333333-3333-4333-8333-333333333333";

export function allowAll(accountId = TEST_ACCOUNT): Authorizer {
  return {
    authorize: async (_header, organizationId) => ({ accountId, sessionId: "session", ...(organizationId ? { organizationId } : {}) }),
    authorizeAction: async (_header, _action, scope = {}) => ({
      accountId, sessionId: "session", ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      role: "tenant_operator", roleGrantId: "grant", roleGrantVersion: 1
    })
  };
}

/** Members pass authorize(); every role-gated action is forbidden. */
export function memberOnly(accountId = TEST_ACCOUNT): Authorizer {
  return {
    authorize: allowAll(accountId).authorize,
    authorizeAction: async () => { throw new AuthenticationError("forbidden"); }
  };
}

export function denyAll(): Authorizer {
  return {
    authorize: async () => { throw new AuthenticationError("forbidden"); },
    authorizeAction: async () => { throw new AuthenticationError("forbidden"); }
  };
}

export function req(method: string, body?: unknown, headers: Record<string, string> = {}, url = "https://engine.test/api"): Request {
  return new Request(url, {
    method,
    headers: { authorization: "Bearer test", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
  });
}

export function anonymous(url = "https://engine.test/api"): Request {
  return new Request(url);
}
