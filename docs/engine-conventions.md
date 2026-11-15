# Engine implementation conventions

These rules apply to every milestone module (LC-10 onward). They keep the engine
domain-neutral, tenant-isolated and auditable.

## Layout per module `<name>`

| Layer | Location | Notes |
| --- | --- | --- |
| Pure logic | `packages/domain/src/<name>.ts` + `<name>.test.ts` (vitest) | No I/O. Clock/randomness injected. Throw `DomainError(code)`. |
| Schema | `packages/db/migrations/NNNN_<name>.sql` | Hand-written SQL. Use `--> statement-breakpoint` between statements. Never edit earlier migrations. |
| Storage/service | `packages/db/src/<name>.ts` + `<name>.test.ts` (node:test, real PostgreSQL) | Raw SQL via `getSqlClient()`; multi-step writes in `sql.begin`. |
| HTTP | `apps/web/src/app/api/.../handler.ts`, `route.ts`, `handler.test.ts` (vitest) | Handlers take injected authorizer + service functions; `route.ts` wires Postgres implementations. |
| Docs | `docs/<name>.md` | Contract, authorization matrix, failure modes, what is NOT claimed. |

Packages export subpaths by wildcard (`@live-competition-engine/db/<name>`,
`@live-competition-engine/domain/<name>`), so no `package.json` edits are needed.
`packages/db/src/schema.ts` (Drizzle) is optional for new tables; migrations are the source of truth.

## Tenancy

* Every tenant-owned table has `organization_id uuid NOT NULL REFERENCES organizations(id)` and
  `UNIQUE (organization_id, id)`; references to tenant-owned rows are composite
  `(organization_id, x_id) REFERENCES x(organization_id, id)`.
* Competitions are "events" (`competitions` table). Use `(organization_id, competition_id)` FKs.
* Every service function takes `organizationId` as its first argument and filters by it.
* Each module has at least one integration test that attempts a cross-tenant read or write and
  proves it fails.

## Authorization

Use `requireAction` / `requireMember` / `optionalMember` from `apps/web/src/lib/http.ts`.

| Need | Check |
| --- | --- |
| Platform administration | `platform.manage` (no org) |
| Tenant administration | `tenant.manage` in org |
| Event/competition operation | `event.manage` in org (+ competitionId for producer grants) |
| Entrant submission | `performance.submit` with competitionId |
| Judging | `judging.score` with competitionId |
| Private member content | `content.view_private` |
| Industry discovery | `industry.discover` |
| Audience participation (vote, chat, follow) | `requireMember` (active membership) |
| Public reads | none; return only explicit public projections |

Identity is always taken from the authenticated principal, never from the request body.

## Feature flags and monetization

Optional capabilities call `requireEnabledFeature(feature, { organizationId, eventId?, accountId? })`
from `@live-competition-engine/db/feature-guard` **before** side effects. Disabled features must
never surface payments, fees or purchase gates. Feature keys live in `packages/config/src/features.ts`.

## Audit

State changes that matter (decisions, publications, money, moderation, scores, votes) call
`recordAudit(tx, {...})` from `@live-competition-engine/db/audit` inside the same transaction.
The log is append-only and hash-chained per tenant (`verifyAuditChain`).

## Errors

Throw `DomainError("snake_case_code")`. `domainFailure()` maps `*_not_found` → 404,
`*conflict*`/`invalid_state*` → 409, `forbidden`/`feature_disabled` → 403, `rate_limited` → 429,
other codes → 400. Unknown errors propagate (500).

## Concurrency

Use optimistic `revision` columns (`WHERE revision = $expected`) or `SELECT ... FOR UPDATE`
for state machines. Idempotency keys (`UNIQUE (organization_id, idempotency_key)`) for anything
a client may retry, especially money.

## External providers

Payment, streaming and email providers sit behind interfaces in `packages/db/src/providers/`.
Real adapters read credentials from validated configuration and fail closed when absent; tests
use deterministic fakes. Never claim a mock proves production behavior.

## Testing

`packages/db/src/test-fixtures.ts` creates unique tenants, accounts, grants, competitions,
entries and feature flags. Tests must be safe to run concurrently against one database:
use random IDs and never truncate shared tables.

Provider credentials are declared in `packages/config/src/providers.ts` (all optional). Use
`requireStripe()`, `requireMux()`, `requirePostmark()`; they throw `provider_not_configured`.

## Tenant lifecycle

`AuthStore.hasActiveMembership` (Postgres) requires `organizations.status = 'active'`, so a
suspended or deletion-scheduled tenant (LC-53) fails closed on every authenticated tenant API.
Platform-scope routes (`platform.manage`, no organization) keep working for super-admins.
