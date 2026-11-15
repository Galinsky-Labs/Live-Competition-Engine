# LC-43 Tenant administration console

Self-service controls for a tenant's operators: members, invitations, role grants, venues,
a show overview, a moderation summary and a billing placeholder.

## Storage (migration `0060_tenant_admin.sql`)

| Table | Purpose |
| --- | --- |
| `organization_invitations` | Email invitations. Only `sha256("invitation\0" + token)` is stored; the 32-byte token is returned once. One pending invitation per (tenant, email); re-inviting revokes the previous one. Status `pending → accepted | revoked`; expiry enforced at acceptance. |
| `venues` | Tenant-owned venues with optimistic `revision`; archived (never deleted) so past events keep references. Active names are unique per tenant (case-insensitive). |
| `competition_venues` | One venue per event; composite tenant FKs to `competitions` and `venues`. |

Membership suspension reuses `organization_memberships.status/suspended_at`. Role grants reuse
`role_grants` (migration 0003): revocation sets `revoked_at` and preserves the row.

## Service (`packages/db/src/tenant-admin.ts`)

`createInvitation`, `revokeInvitation`, `listInvitations`, `acceptInvitation`, `listMembers`
(with active grants), `setMembershipStatus`, `grantTenantRole`, `revokeTenantRole`,
`createVenue`, `updateVenue`, `archiveVenue`, `listVenues`, `assignCompetitionVenue`,
`showOverview`. Every state change writes `recordAudit` in the same transaction
(`tenant.invitation_*`, `tenant.member_*`, `tenant.role_*`, `tenant.venue_*`).

Rules (pure logic in `packages/domain/src/tenant-admin.ts`):

* Grantable roles: `tenant_operator`, `event_producer`, `performer`, `judge`, `viewer`,
  `industry_scout`. `platform_operator` is never grantable (also refused for revoke).
  `event_producer`/`performer`/`judge` require a `competitionId` in the same tenant; the others must not have one.
* Grants require an active membership. Duplicate active grants → `role_grant_conflict` (unique partial index, race-safe).
* An operator cannot suspend themself or revoke their own `tenant_operator` grant (lock-out guard).
* Invitations carry an optional tenant-wide initial role (`tenant_operator`, `viewer`, `industry_scout`).
  Acceptance requires an authenticated account whose stored email equals the invited email; a suspended
  membership is not silently reactivated (`invalid_state_membership_suspended`).

## Overview sections (`packages/db/src/admin-overview.ts`)

`billingSection` and `moderationSection` take a pluggable provider. With no provider the
section returns `{ status: "not_configured" }`; a throwing provider yields `{ status: "unavailable" }`
so the console never fails as a whole. Billing has no provider in this branch (commerce is built in
parallel: register one with `registerBillingVisibilityProvider`). Moderation is wired to LC-46.

## HTTP (all `tenant.manage` in the tenant unless noted)

| Method | Path |
| --- | --- |
| GET | `/api/organizations/{org}/admin/overview` |
| GET | `/api/organizations/{org}/admin/members?limit&offset` |
| POST | `/api/organizations/{org}/admin/members/{accountId}/status` `{status}` |
| POST | `/api/organizations/{org}/admin/members/{accountId}/grants` `{role, competitionId?, expiresAt?}` |
| DELETE | `/api/organizations/{org}/admin/grants/{grantId}` |
| GET, POST | `/api/organizations/{org}/admin/invitations` `{email, initialRole?, ttlMs?}` |
| DELETE | `/api/organizations/{org}/admin/invitations/{invitationId}` |
| POST | `/api/organizations/{org}/invitations/accept` `{token}` — any authenticated account; 410 when expired |
| GET, POST | `/api/organizations/{org}/venues` |
| PUT, DELETE | `/api/organizations/{org}/venues/{venueId}` (PUT needs `expectedRevision`) |
| PUT | `/api/organizations/{org}/competitions/{competitionId}/venue` `{venueId|null}` |

## Pages

`/admin/{org}` (overview), `/admin/{org}/members`, `/admin/{org}/venues` — server-rendered, read-only,
authorized with `tenant.manage` from an `Authorization` header or an `lce_session` cookie holding the
session token (`apps/web/src/lib/page-auth.ts`). Mutations go through the API.

## Not claimed

* Invitation emails are not sent by this module; the caller delivers the one-time token (LC-47 can).
* No login UI sets the `lce_session` cookie yet.
* Billing data is a placeholder until a commerce provider is registered.
