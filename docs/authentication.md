# Authentication and identity

LC-03 establishes a framework-neutral authentication boundary. Accounts can link
verified external identities without storing provider credentials. API callers
receive 256-bit opaque bearer tokens; only domain-separated SHA-256 digests are
persisted. Sessions expire, can be individually revoked, and are invalidated as
a group when recovery increments the account recovery epoch.

Recovery codes are random, one-time values shown only at issuance. A database
adapter must consume a recovery digest, increment the recovery epoch, mark the
code used and revoke active sessions in one transaction. The service deliberately
models that operation as one store method so adapters cannot partially recover an
account. Codes and raw session tokens must never be logged.

Authorization can bind a request to an active organization membership. Missing,
malformed, expired, revoked, recovered or cross-organization credentials fail
closed. Membership alone grants no role. LC-04 adds explicit, versioned role grants and a
fail-closed action matrix; see `authorization.md`. Interactive provider callbacks, email delivery and production
rate limiting require deployed-provider evidence and are not claimed here.

## First-party sign-in (email + password)

- `POST /api/auth/signup` and `POST /api/auth/login` accept `{email, password}`; passwords are 12–256 characters and stored only as salted scrypt hashes (`account_credentials`). Sign-in failures are generic (`invalid`) and five failures per email in 15 minutes return `429 throttled`; the attempt log stores SHA-256 email digests, never raw addresses.
- Success issues the same opaque session used by bearer clients. The UI receives it as an `HttpOnly; SameSite=Lax` cookie (`Secure` in production). API clients may pass `"mode":"token"` to receive the bearer token in the body.
- Route handlers accept either `Authorization: Bearer` or the cookie. Cookie-authenticated mutations require a same-origin `Origin` header (CSRF defence in depth).
- `POST /api/auth/logout` revokes the session and clears the cookie. `GET /api/auth/session` returns the account and its tenant roles.
- `POST /api/organizations` lets a signed-in account create a tenant; it becomes an active member and `tenant_operator`. `POST /api/organizations/{id}/members` (tenant.manage) adds an existing account by email.
- `engine_audit_log` is an append-only (trigger-enforced) audit trail used by engine modules.
- Not yet provided: email verification and password reset by email (needs an email provider; recovery codes from LC-03 remain the reset path).
