import { cookies, headers } from "next/headers";
import { AuthenticationError, type AuthorizedPrincipal, type ProtectedAction } from "@live-competition-engine/auth";
import { isUuid } from "@live-competition-engine/domain";
import { authService } from "./services";

/**
 * Server-rendered console pages authenticate with the same opaque session token
 * as the API: either an `Authorization: Bearer` header (reverse proxy / tests) or
 * an `lce_session` cookie holding the raw token. No token, or a token without the
 * required action, renders an access-denied page; nothing is ever shown by default.
 */
export async function pageAuthorizationHeader(): Promise<string | null> {
  const header = (await headers()).get("authorization");
  if (header) return header;
  const token = (await cookies()).get("lce_session")?.value;
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? `Bearer ${token}` : null;
}

export type PageAuth = { ok: true; principal: AuthorizedPrincipal } | { ok: false; reason: "unauthenticated" | "forbidden" | "not_found" };

export async function authorizePage(action: ProtectedAction, organizationId?: string): Promise<PageAuth> {
  if (organizationId !== undefined && !isUuid(organizationId)) return { ok: false, reason: "not_found" };
  try {
    const principal = await authService().authorizeAction(await pageAuthorizationHeader(), action, organizationId ? { organizationId } : {});
    return { ok: true, principal };
  } catch (error) {
    if (error instanceof AuthenticationError) return { ok: false, reason: error.code === "forbidden" ? "forbidden" : "unauthenticated" };
    throw error;
  }
}
