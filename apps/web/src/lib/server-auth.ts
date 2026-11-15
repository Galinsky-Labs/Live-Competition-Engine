import { cookies } from "next/headers";
import { AuthenticationError, AuthenticationService, type ProtectedAction } from "@live-competition-engine/auth";
import { CredentialService } from "@live-competition-engine/auth/credentials";
import { createPostgresAuthStore } from "@live-competition-engine/db/auth-store";
import { accountSummary, createPostgresCredentialStore } from "@live-competition-engine/db/credential-store";
import { authorizationHeader, SESSION_COOKIE } from "./http";

let authService: AuthenticationService | undefined;
let credentialService: CredentialService | undefined;

export function getAuth(): AuthenticationService {
  authService ??= new AuthenticationService(createPostgresAuthStore());
  return authService;
}

export function getCredentials(): CredentialService {
  credentialService ??= new CredentialService(createPostgresCredentialStore(), getAuth());
  return credentialService;
}

export const secureCookies = () => process.env.NODE_ENV === "production";

/** Authenticated account (no role requirement). */
export function requireAccount(request: Request, organizationId?: string) {
  return getAuth().authorize(authorizationHeader(request), organizationId);
}

export function requireAction(request: Request, action: ProtectedAction, scope: { organizationId?: string; competitionId?: string }) {
  return getAuth().authorizeAction(authorizationHeader(request), action, scope);
}

/** Returns the principal for an optional session (public endpoints that personalise when signed in). */
export async function optionalAccount(request: Request) {
  if (!authorizationHeader(request)) return null;
  try {
    return await requireAccount(request);
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}

/** Server-component helper: the signed-in account summary, or null. */
export async function currentAccount() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const principal = await getAuth().authorize(`Bearer ${token}`);
    return await accountSummary(principal.accountId);
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}

/** Server-component helper: authorizes the cookie session for an action, returning null instead of throwing. */
export async function pagePrincipal(action: ProtectedAction, scope: { organizationId?: string; competitionId?: string }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await getAuth().authorizeAction(`Bearer ${token}`, action, scope);
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}

export async function pageAccount() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await getAuth().authorize(`Bearer ${token}`);
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}
