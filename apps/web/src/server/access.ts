import type { ProtectedAction } from "@live-competition-engine/auth";
import { AuthenticationError } from "@live-competition-engine/auth";
import { authorizationHeader } from "@/lib/http";
import { getAuth } from "@/lib/server-auth";
import type { RouteContext } from "./router";

/** Requires `event.manage` for this event (tenant operator, or producer scoped to the event). */
export const manageEvent = (ctx: RouteContext) =>
  getAuth().authorizeAction(authorizationHeader(ctx.request), "event.manage", { organizationId: ctx.organizationId, competitionId: ctx.params.eventId! });

export const manageTenant = (ctx: RouteContext) =>
  getAuth().authorizeAction(authorizationHeader(ctx.request), "tenant.manage", { organizationId: ctx.organizationId });

export const actOnEvent = (ctx: RouteContext, action: ProtectedAction) =>
  getAuth().authorizeAction(authorizationHeader(ctx.request), action, { organizationId: ctx.organizationId, competitionId: ctx.params.eventId! });

/** Any signed-in account (no tenant membership required), e.g. audience members. */
export const signedIn = (ctx: RouteContext) => getAuth().authorize(authorizationHeader(ctx.request));

/** Returns true when the caller may manage the event; never throws for auth failures. */
export async function canManageEvent(ctx: RouteContext): Promise<boolean> {
  try {
    await manageEvent(ctx);
    return true;
  } catch (error) {
    if (error instanceof AuthenticationError) return false;
    throw error;
  }
}

export async function optionalSignedIn(ctx: RouteContext) {
  if (!authorizationHeader(ctx.request)) return null;
  try {
    return await signedIn(ctx);
  } catch (error) {
    if (error instanceof AuthenticationError) return null;
    throw error;
  }
}
