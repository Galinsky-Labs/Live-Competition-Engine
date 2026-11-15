import { AuthenticationError, type CompetitionRole, type ProtectedAction } from "@live-competition-engine/auth";

/** Test-only authorizer: grants exactly the listed actions to `accountId`. */
export function fakeAuthorizer(accountId: string, actions: readonly ProtectedAction[], role: CompetitionRole = "event_producer") {
  return {
    async authorize(header: string | null, organizationId?: string) {
      if (!header) throw new AuthenticationError("missing");
      return { accountId, sessionId: "session", ...(organizationId ? { organizationId } : {}) };
    },
    async authorizeAction(header: string | null, action: ProtectedAction, scope: { organizationId?: string } = {}) {
      if (!header) throw new AuthenticationError("missing");
      if (!actions.includes(action)) throw new AuthenticationError("forbidden");
      return {
        accountId, sessionId: "session", ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        role, roleGrantId: "grant", roleGrantVersion: 1 as const
      };
    }
  };
}

export const ORG = "11111111-1111-4111-8111-111111111111";
export const COMP = "22222222-2222-4222-8222-222222222222";
export const ACCOUNT = "33333333-3333-4333-8333-333333333333";

export function jsonRequest(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://engine.test/api", {
    method,
    headers: { authorization: "Bearer test", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

export function domainError(code: string) {
  return Object.assign(new Error(code), { code });
}
