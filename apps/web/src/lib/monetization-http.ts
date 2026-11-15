import type { AuthenticationService, Principal } from "@live-competition-engine/auth";
import { domainFailure, errorResponse, requireAction, requireMember } from "./http";

/** Shared helpers for payment/monetization handlers (LC-31..36). */
export type MonetizationAuthorizer = Pick<AuthenticationService, "authorize" | "authorizeAction">;

/** Provider errors become 503/502 so clients can tell outages from bad input. */
export const providerStatus: Record<string, number> = {
  provider_not_configured: 503,
  provider_unavailable: 503,
  provider_rejected: 502,
  idempotency_conflict: 409,
  refund_exceeds_remaining: 409,
  sold_out: 409,
  sales_closed: 409,
  quote_changed: 409,
  self_tip_forbidden: 403
};

/** Map DomainError (and ProviderNotConfiguredError) codes; rethrow anything else. */
export function monetizationFailure(error: unknown): Response {
  return domainFailure(error, providerStatus);
}

export async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    return monetizationFailure(error);
  }
}

/** Authenticated member who either owns the resource or holds tenant.manage. */
export async function requireOwnerOrManager(
  authorizer: MonetizationAuthorizer,
  request: Request,
  organizationId: string,
  ownerAccountId: () => Promise<string | null>
): Promise<Principal | Response> {
  const principal = await requireMember(authorizer, request, organizationId);
  if (principal instanceof Response) return principal;
  const owner = await ownerAccountId();
  if (owner === null) return errorResponse(404, "not_found");
  if (owner === principal.accountId) return principal;
  return requireAction(authorizer, request, "tenant.manage", { organizationId });
}

/** Idempotency key from the `Idempotency-Key` header or body field. */
export function idempotencyKeyOf(request: Request, body: Record<string, unknown>): string | null {
  const value = request.headers.get("idempotency-key") ?? body.idempotencyKey;
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{8,120}$/.test(value) ? value : null;
}

export function intField(body: Record<string, unknown>, name: string): number | undefined | null {
  const value = body[name];
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
