# SaaS plan management (LC-49)

Platform-defined, versioned plans; tenant subscriptions with trial / upgrade / downgrade
semantics; append-only usage metering; and a plan-limit entitlement check other modules call.
**Billing collection is LC-51.** This module computes and records amounts (proration,
period charges) on the subscription change history; it never charges anyone.

## Storage (migration `0080_saas_plans.sql`)

| Table | Purpose |
| --- | --- |
| `saas_plans` | Plan versions: `plan_key` + `version`, price per interval in minor units (`price_minor`, `currency`, `billing_interval` month/year), `trial_days` (0–90), `features` (array of LC-08 feature keys), `limits` (object). Status `draft → published → retired`. A trigger makes commercial terms of a published version immutable and forbids deleting or republishing it. |
| `tenant_subscriptions` | One open (non-cancelled) subscription per tenant (partial unique index). `status`, current period, pending (scheduled) plan, `revision` for optimistic locking. |
| `tenant_subscription_changes` | Append-only history (UPDATE blocked by trigger): every start, upgrade, scheduled/cancelled/applied downgrade, renewal, trial end and status change, with `charge_minor`, `credit_minor`, `net_minor`, `currency` and an optional `idempotency_key` (unique per tenant). |
| `usage_records` | Append-only metered usage (`metric`, signed `quantity`, `occurred_at`, derived UTC month `period_start`, `source`, `idempotency_key` unique per tenant). UPDATE blocked by trigger. Rows are removed only by tenant deletion cascade. |

Rollback: drop the four tables and the functions `saas_plans_freeze_published`, `saas_append_only`.

## Limits

`limits` must define every key; `null` means unlimited, a missing key is treated as `0` (fail closed).

| Limit key | Measured from |
| --- | --- |
| `max_events_per_month` | `competitions` created in the current UTC calendar month |
| `max_members` | active `organization_memberships` |
| `max_custom_domains` | `organization_domains` not `disabled` |
| `max_storage_bytes` | sum of `usage_records` with metric `storage_bytes` (producers record signed deltas) |

### `checkPlanLimit(organizationId, limitKey, increment = 1, { sql?, now? })`

`@live-competition-engine/db/saas-plans`. Returns `{ allowed, reason, limit, current, requested,
remaining, planId }`. `reason` is `within_limit`, `limit_exceeded` or `no_active_subscription`
(**no open subscription ⇒ nothing allowed**). `past_due` keeps entitlements (dunning policy is LC-51).
Pass your transaction as `sql` to take a per-tenant, per-limit advisory lock and insert the resource in
the same transaction; the integration test proves three concurrent creators against a limit of 1
yield exactly one success. `assertPlanLimit` throws `DomainError("plan_limit_exceeded")` /
`("no_active_subscription")`. `planAllowsFeature(org, feature)` reports the plan allowance for an
LC-08 feature family; it never turns a flag on — callers must require both.

## Subscription semantics

* **Start** (published plan only): `trialing` for `trial_days` when > 0, else `active` with the first
  period charge on the `started` change.
* **States:** `trialing → active | past_due | cancelled`, `active → past_due | cancelled`,
  `past_due → active | cancelled`, `cancelled` terminal. Anything else is `invalid_state_subscription_transition` (409).
* **Upgrade** (higher price) and **lateral** (equal price) apply immediately; amounts come from the pure
  `computeProration` (BigInt, half-up rounding per component): credit = old price × remaining/period,
  charge = new price × remaining/period, net = charge − credit. During a trial every change is immediate and free.
* **Downgrade** (lower price) is scheduled for the end of the current period (`pending_plan_id`) and
  can be cancelled (`DELETE …/subscription/pending-change`).
* **Usage over new limits:** an immediate change is **blocked** (409 `plan_change_usage_exceeds_limits`
  with `violations`). A downgrade is blocked too unless `acknowledgeOverage: true`, in which case it is
  scheduled with `pending_overage_flagged = true`, and the overage is re-measured and recorded when applied.
* Currency or interval changes are refused (`plan_change_currency_mismatch` / `plan_change_interval_mismatch`).
* `advanceSubscription(org, now)` applies due steps (trial end → `active` with the period charge;
  scheduled downgrade; renewal), at most 24 per call, under a row lock. It is meant for a scheduled worker;
  **no worker/cron is wired yet**.
* Retiring a plan version stops new subscriptions; existing subscribers keep that version.

Idempotency: start and change take `idempotencyKey` (`[A-Za-z0-9_.:-]{8,128}`); a replay returns the
original result. Usage records with the same key and payload are no-ops; a different payload is
`usage_idempotency_conflict`.

## HTTP API

| Route | Method | Authorization |
| --- | --- | --- |
| `/api/platform/plans` | GET (`?status=`), POST (create draft version) | `platform.manage` |
| `/api/platform/plans/[planId]/publish` · `/retire` | POST | `platform.manage` |
| `/api/platform/tenants/[organizationId]/subscription` | POST `{status: active\|past_due\|cancelled, expectedRevision?, reason?}` | `platform.manage` |
| `/api/organizations/[organizationId]/subscription` | GET, POST `{planId, idempotencyKey}` | `tenant.manage` |
| `/api/organizations/[organizationId]/subscription/change` | POST `{planId, idempotencyKey, acknowledgeOverage?}` (200 applied, 202 scheduled, 409 blocked) | `tenant.manage` |
| `/api/organizations/[organizationId]/subscription/pending-change` | DELETE | `tenant.manage` |
| `/api/organizations/[organizationId]/subscription/cancel` | POST `{reason?}` (immediate) | `tenant.manage` |
| `/api/organizations/[organizationId]/usage` | GET `?period=YYYY-MM` → aggregates + every limit decision | `tenant.manage` |

Tenant routes also run the LC-53 tenant lifecycle guard (suspended → 423).

## Audit

Plan creation/publication/retirement is recorded on the platform chain (`organizationId: null`);
subscription events on the tenant chain, inside the same transaction as the change.

## Tested

* `packages/domain/src/saas-plans.test.ts` — validation, classification, proration (rounding, overflow), limits, transitions, interval arithmetic.
* `packages/db/src/saas-plans.test.ts` — versioning and immutability trigger, full lifecycle with exact proration
  amounts, idempotent replay, blocked/flagged downgrades, concurrency on a limit, usage idempotency/aggregation,
  append-only trigger, cross-tenant negatives, audit chain verification.
* Handler tests — authorized, 403, invalid input, not found, conflict mapping, guard.

## Not implemented / not claimed

* No payment collection, invoices, tax or dunning (LC-51). Amounts are informational records.
* No scheduler calling `advanceSubscription`; no automatic sync from plan features to LC-08 flags.
* Existing modules (domains, members, media) do not yet call `checkPlanLimit`; LC-50 first-event creation does.
