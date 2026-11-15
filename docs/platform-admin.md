# Platform super-admin (LC-53)

Tenant lifecycle, step-up authentication for destructive actions, fraud flags, support notes,
versioned global announcements/release notes, and the platform audit view.

## Authorization

Every platform route requires `platform.manage` — a `platform_operator` role grant with no tenant
or competition scope (`requireAction(..., "platform.manage")`). Identity is always the bearer
session's account; nothing is taken from the request body.

**Impersonation is NOT supported, by design.** There is no endpoint, token type or session flag that
lets an operator act as a tenant member. Operators change tenants only through the audited platform
actions below. Support work that needs tenant data must be done with the tenant's cooperation
(e.g. a role grant the tenant issues), which is then visible in the tenant's own audit chain.

## Step-up authentication

Destructive actions — `suspend`, `schedule_deletion`, `finalize_deletion` — require a step-up grant:

* `POST /api/platform/step-up {"method":"recovery_code","recoveryCode":"…"}` spends one of the
  operator's own unused LC-03 recovery codes (marks it used, **without** revoking sessions, unlike
  `AuthenticationService.recover`).
* `POST /api/platform/step-up {"method":"fresh_session"}` succeeds only if the calling session was
  issued in the last 5 minutes (i.e. the operator just re-authenticated, e.g. via `recover`).

Both return `{ token, expiresAt, header: "x-step-up-token" }`. Grants live in `step_up_grants`
(only `sha256("step-up\0"+token)` stored), expire after **10 minutes** (also a DB CHECK constraint),
and are **bound to the session id and account**: another session, another operator, an expired
grant, or a revoked/expired session all fail with 403 `step_up_required`. `DELETE /api/platform/step-up`
revokes the session's grants. Grant issuance is audited (`platform.step_up_granted`); the lifecycle
event and audit record carry the grant id used.

There is no password or OIDC re-authentication in the engine yet; when one exists it should issue
`fresh_session` grants (or call an equivalent of `stepUpWithFreshSession`).

## Tenant lifecycle

Migration `0082_platform_admin.sql` adds, with `ADD COLUMN IF NOT EXISTS`, `organizations.status`
(`active` default, so existing rows stay active), `status_changed_at`, `deletion_scheduled_for` and
`lifecycle_revision`.

| Action | From → To | Step-up |
| --- | --- | --- |
| `suspend` | active → suspended | yes |
| `reactivate` | suspended → active | no |
| `schedule_deletion` | active / suspended → scheduled_deletion (+30 days) | yes |
| `cancel_deletion` | scheduled_deletion → **suspended** (reactivation is a separate decision) | no |
| `finalize_deletion` | scheduled_deletion → deleted, only after the grace date | yes |

`POST /api/platform/tenants/[organizationId]/lifecycle {action, reason, expectedRevision}` with
`X-Step-Up-Token`. Row lock + optimistic `expectedRevision` (409 `tenant_revision_conflict`; three
concurrent suspends → exactly one wins, tested). Each change writes an append-only
`organization_lifecycle_events` row and a platform-chain audit event `platform.tenant_<action>`.

`deleted` is a terminal *status*: **no data is purged**. A purge/export job honouring the grace period
is future work (LC-54/55), as is notifying tenants.

### `assertTenantActive(organizationId, sql?)`

`@live-competition-engine/db/platform-admin`. Throws `tenant_not_found`, `tenant_suspended`,
`tenant_scheduled_for_deletion` or `tenant_deleted` (HTTP 404/423/423/410 in this module's handlers);
pass a transaction to read under `FOR SHARE`. Wired into: subscription and usage APIs (LC-49) and
onboarding / first-event APIs (LC-50). **Not yet wired into other modules' tenant APIs** — the
coordinator should call it from the shared `requireAction`/`requireMember` helpers in
`apps/web/src/lib/http.ts` (a file this module may not edit). Tenant members can still read platform
announcements while suspended (deliberate: they may explain the suspension).

## Fraud flags and support notes

* `platform_fraud_flags`: subject is an organization or an account; severity low/medium/high/critical;
  `open → resolved` with resolution text and optimistic `revision`. Flags are informational — they
  do not suspend anything automatically.
* `platform_support_notes`: append-only (UPDATE trigger). The audit event stores only the note's SHA-256,
  not its text (notes may contain personal data).

## Announcements / release notes

`platform_announcements` + `platform_announcement_versions`. Creating makes draft v1; edits add a new
draft version; publishing makes that version the live one (`published_version`); published versions
are immutable (trigger blocks UPDATE/DELETE). A version may target a list of tenant ids (null = all).
Tenants see the live version only if it targets them, so publishing a narrower version hides the
announcement from tenants outside the new target list. Withdrawal hides it everywhere and is final.
Tenant read: `GET /api/organizations/[organizationId]/announcements` (active membership).

## API summary (all `platform.manage` unless noted)

| Route | Methods |
| --- | --- |
| `/api/platform/step-up` | POST, DELETE |
| `/api/platform/tenants` | GET `?status&q&limit&offset` |
| `/api/platform/tenants/[organizationId]` | GET (tenant, lifecycle history, notes, flags) |
| `/api/platform/tenants/[organizationId]/lifecycle` | POST (+ `X-Step-Up-Token` when destructive) |
| `/api/platform/tenants/[organizationId]/notes` | GET, POST `{body}` |
| `/api/platform/tenants/[organizationId]/subscription` | POST (LC-49 status override) |
| `/api/platform/fraud-flags` | GET `?status&organizationId&accountId`, POST `{subjectType, subjectId, severity, reason}` |
| `/api/platform/fraud-flags/[flagId]/resolve` | POST `{resolution, expectedRevision}` |
| `/api/platform/announcements` | GET, POST `{kind, title, body, severity?, targetOrganizationIds?}` |
| `/api/platform/announcements/[announcementId]/versions` · `/publish {version}` · `/withdraw` | POST |
| `/api/platform/audit` | GET `?limit&before` → events + full platform-chain verification |
| `/api/organizations/[organizationId]/announcements` | GET (active member) |

## Pages

`/platform/tenants` (search/filter), `/platform/tenants/[organizationId]` (lifecycle with step-up
panel, history, fraud flags, notes), `/platform/tenants/announcements`, `/platform/tenants/audit`.
The operator pastes their session token (kept in `sessionStorage` for the tab); every request is
authorized server-side. Pages are `noindex`.

## Tested

* `packages/domain/src/platform-admin.test.ts` — transitions, grace, validation.
* `packages/db/src/platform-admin.test.ts` — step-up (single-use code, session binding, other operator,
  expiry, DB 10-minute ceiling, fresh-session window, revocation, revoked session), full lifecycle
  incl. grace enforcement and tenant API blocking, concurrency, append-only triggers, flag/note scoping
  across tenants, announcement versioning/targeting/withdrawal, platform audit chain verification.
* `apps/web/src/app/api/platform/tenants/handler.test.ts` — 403 for every route without platform.manage,
  step-up header pass-through, error mapping, query validation, member-only tenant read.

## Not implemented / not claimed

No data purge or export on deletion, no tenant notification, no automatic action on fraud flags, no
WebAuthn/TOTP step-up, and no external human security review of this module (AI-assisted review only).
