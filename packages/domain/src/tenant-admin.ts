import { DomainError, isBoundedText, isUuid } from "./index.ts";

/** Roles a tenant operator may grant inside its own tenant. platform_operator is never grantable here. */
export const tenantGrantableRoles = [
  "tenant_operator",
  "event_producer",
  "performer",
  "judge",
  "viewer",
  "industry_scout"
] as const;
export type TenantGrantableRole = (typeof tenantGrantableRoles)[number];

/** Roles whose grants are scoped to one competition (event) inside the tenant. */
export const competitionScopedRoles: readonly TenantGrantableRole[] = ["event_producer", "performer", "judge"];
/** Roles an invitation may carry (tenant-wide scope only). */
export const invitationRoles = ["tenant_operator", "viewer", "industry_scout"] as const;
export type InvitationRole = (typeof invitationRoles)[number];

export const INVITATION_TTL_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;
export const INVITATION_TTL_MS_MAX = 30 * 24 * 60 * 60 * 1000;

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("invalid_email");
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) {
    throw new DomainError("invalid_email");
  }
  return email;
}

export interface RoleGrantRequest {
  role: TenantGrantableRole;
  competitionId: string | null;
}

/** Validate a tenant-operator role grant: never platform_operator; competition scope exactly where required. */
export function parseRoleGrantRequest(input: { role?: unknown; competitionId?: unknown }): RoleGrantRequest {
  const role = input.role;
  if (typeof role !== "string" || !(tenantGrantableRoles as readonly string[]).includes(role)) {
    throw new DomainError("role_not_grantable");
  }
  const scoped = competitionScopedRoles.includes(role as TenantGrantableRole);
  const competitionId = input.competitionId ?? null;
  if (scoped) {
    if (!isUuid(competitionId)) throw new DomainError("invalid_competition_scope");
    return { role: role as TenantGrantableRole, competitionId };
  }
  if (competitionId !== null) throw new DomainError("invalid_competition_scope");
  return { role: role as TenantGrantableRole, competitionId: null };
}

export function parseInvitationRole(value: unknown): InvitationRole | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(invitationRoles as readonly string[]).includes(value)) {
    throw new DomainError("role_not_grantable");
  }
  return value as InvitationRole;
}

export function invitationExpiry(now: Date, ttlMs: unknown = INVITATION_TTL_MS_DEFAULT): Date {
  const ttl = ttlMs === undefined ? INVITATION_TTL_MS_DEFAULT : ttlMs;
  if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > INVITATION_TTL_MS_MAX) {
    throw new DomainError("invalid_invitation_ttl");
  }
  return new Date(now.getTime() + ttl);
}

export interface VenueInput {
  name: string;
  address: string | null;
  capacity: number | null;
  timezone: string | null;
}

export function parseVenueInput(input: Record<string, unknown>): VenueInput {
  const name = typeof input.name === "string" ? input.name.trim() : input.name;
  if (!isBoundedText(name, 160, 1)) throw new DomainError("invalid_venue_name");
  const address = input.address ?? null;
  if (address !== null && !isBoundedText(address, 500)) throw new DomainError("invalid_venue_address");
  const capacity = input.capacity ?? null;
  if (capacity !== null && (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000)) {
    throw new DomainError("invalid_venue_capacity");
  }
  const timezone = input.timezone ?? null;
  if (timezone !== null && (typeof timezone !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(timezone) || timezone.length > 64)) {
    throw new DomainError("invalid_venue_timezone");
  }
  return { name: name as string, address: address as string | null, capacity: capacity as number | null, timezone: timezone as string | null };
}

/** Membership status machine: active <-> suspended only. */
export function assertMembershipTransition(from: "active" | "suspended", to: "active" | "suspended"): void {
  if (from === to) throw new DomainError(`invalid_state_membership_already_${to}`);
}
