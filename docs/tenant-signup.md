# Tenant signup and onboarding (LC-50)

Public self-service creation of a tenant, email verification, an onboarding checklist computed
from real data, and a guided first-event endpoint.

## Identity model (read this first)

The engine has **no password or OIDC login** yet. Identity is the LC-03 model: opaque bearer
sessions plus single-use recovery codes. Signup therefore:

1. creates the account with an **unverified** email (`accounts.email_verified_at IS NULL`);
2. immediately issues a bearer session through `AuthenticationService.issueSession` (returned once
   in the signup response; the signup page keeps it in `sessionStorage` for that tab only);
3. issues a single-use **email verification token** (32 random bytes, base64url). Only
   `sha256("email-verification\0" + token)` is stored; the token expires after 24 h; issuing a new
   one supersedes older ones; it is bound to the account *and* to the email it was sent to.

Email verification proves control of the mailbox; it does not gate the session. Modules that need
a verified email must check `accounts.email_verified_at` themselves. Recovery codes are not issued
at signup; the operator generates them via the existing recovery flow.

### Verification delivery

`VerificationSender.sendVerification({ accountId, email, token, expiresAt })` is pluggable:

* `createDefaultVerificationSender()` — **delivers nothing**. It logs only
  `"email verification issued …" { accountId }` (no email address, no token). When
  `NODE_ENV=test` it returns `{ testToken }`, which the API echoes as `verification.testToken`;
  in every other mode the token cannot be recovered.
* `createPostmarkVerificationSender(APP_URL)` — real HTTP adapter (`fetch`, 10 s timeout), credentials
  from `requirePostmark()`; fails closed with `provider_not_configured`, and `verification_delivery_failed`
  on a non-2xx response. The web app selects it automatically when `POSTMARK_SERVER_TOKEN` and
  `EMAIL_FROM_DEFAULT` are set. **Only exercised against a fake `fetch` in tests.**

A delivery failure after the signup transaction commits does not undo the signup
(`verification.delivered = false`); the user requests a new email via resend.

## Signup transaction

`signupTenant(input, ipHash, { issueSession, sender })` validates (pure `validateSignup`), consumes a
rate-limit slot, then in ONE transaction inserts: account, organization (unique slug), active
membership, `tenant_operator` role grant (granted by the new account), `tenant_onboarding` row,
verification token, optional trial subscription (`planKey` → latest published version, LC-49), and
audit events on the tenant chain (`tenant.signed_up`) and the platform chain (`tenant.created`).
Any failure rolls everything back (tested: a duplicate slug leaves no orphan account). Concurrent
signups for one slug produce exactly one tenant (tested).

* **Slugs:** 3–40 chars `[a-z0-9-]`, no leading/trailing or doubled hyphen (also excludes punycode),
  not in `RESERVED_SLUGS` (platform route names, infrastructure and trust words), not `fx-*`.
* **Email enumeration:** `email_unavailable` (409) reveals that an address is registered; this is
  bounded by the per-IP rate limit. A future login flow should replace it with a neutral response.
* **Rate limit:** 5 attempts per hour per keyed IP hash, counted under an advisory lock (8 concurrent
  attempts → exactly 5 pass, tested). Attempts are counted even when the signup later fails.
  Only `HMAC-SHA256(SIGNUP_IP_HASH_KEY, ip)` is stored (`signup_attempts.ip_hash`). Set
  `SIGNUP_IP_HASH_KEY` (≥ 32 chars) in production; the built-in fallback key only gives domain
  separation (IPv4 hashes are brute-forceable without a secret). The client IP comes from the first
  `X-Forwarded-For` hop (then `X-Real-IP`); deployments must ensure their proxy sets it. Without
  either header all callers share one bucket (fail closed).

## Onboarding checklist

`getOnboardingChecklist(org)` computes each step from real tables:

| Step | Complete when | Skippable |
| --- | --- | --- |
| `email_verified` | creating account has `email_verified_at` | no |
| `branding_set` | an active `organization_theme_versions` row (LC-06) | yes |
| `custom_domain_claimed` | any `organization_domains` row (LC-07) | yes |
| `members_invited` | more than one active membership | yes |
| `payment_setup` | never yet: **`external_pending`** until LC-51 billing reports | yes |
| `first_event_created` | onboarding `first_event_id` set or any competition exists | no |

`ready` = required steps complete and optional ones complete or skipped.

## Guided first event

`createFirstEvent(org, actor, { title, description?, startsAt? })` creates one `draft` competition per
tenant, under the onboarding row lock; repeated calls return the same event (`created: false`). It
calls `assertPlanLimit(org, "max_events_per_month", 1, { sql: tx })` — **a tenant without a
subscription cannot create events** (402 `no_active_subscription`) — and the LC-53 tenant lifecycle check.

## HTTP API

| Route | Method | Auth |
| --- | --- | --- |
| `/api/signup` | POST `{email, organizationName, slug, planKey?}` → 201 `{accountId, organizationId, slug, subscriptionId, session:{token, expiresAt}, verification:{status, expiresAt, delivered, testToken?}}`; 409 `slug_unavailable`/`email_unavailable`; 429 `rate_limited` | public |
| `/api/signup/slug-availability?slug=` | GET → `{available, slug?, reason?}` | public |
| `/api/signup/verify-email` | POST `{accountId, token}`; 400 `invalid_verification_token` / `verification_expired` | public (token is the proof) |
| `/api/signup/verify-email/resend` | POST → 202; max 5 tokens/hour/account | bearer session (identity from session) |
| `/api/organizations/[organizationId]/onboarding` | GET checklist; POST `{step, skipped}` | `tenant.manage` |
| `/api/organizations/[organizationId]/onboarding/first-event` | POST → 201 created / 200 existing; 402 plan limit | `tenant.manage` |

## Pages

* `/signup` — form (email, organization name, slug with live availability, plan choice from published plans).
* `/signup/verify?account=…&token=…` — verification requires pressing a button (POST), so mail
  scanners that prefetch links cannot consume the token; `referrer: no-referrer`.
* `/signup/onboarding` — checklist with skip/undo, resend verification, and first-event form.

All are server-rendered shells with small client components: labelled fields, `role="alert"` errors,
`aria-live` status, visible focus outlines, no external assets.

## Storage (migration `0081_tenant_signup.sql`)

`accounts.email_verified_at` (ADD COLUMN IF NOT EXISTS), `account_email_verifications`,
`signup_attempts`, `tenant_onboarding` (composite FK so `first_event_id` must be a competition of the
same tenant — tested). Rollback: drop the three tables and the column.

## Not implemented / not claimed

* No password/OIDC login, no invitation emails (members are counted from memberships), no payment setup (LC-51).
* Postmark delivery is untested against the real service; no bounce/complaint handling (LC-52).
* No CAPTCHA/bot defence beyond the IP rate limit; `signup_attempts` has no retention job yet.
