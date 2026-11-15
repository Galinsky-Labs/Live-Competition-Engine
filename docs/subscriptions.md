# LC-34 Creator subscriptions

Status: implemented and integration-tested with normalized provider events (fake provider).
The Stripe subscription path (Checkout `mode=subscription`, `invoice.paid`,
`invoice.payment_failed`, `customer.subscription.deleted`) is unit-tested for request shape and
event normalization only; no live Stripe subscription has been run.

## Features

* `subscriptions` — recurring billing; required for every plan.
* `creator_memberships` — plans offered by a participant or a creator account (in addition to
  `subscriptions`). Tenant-offered plans need only `subscriptions`.

Both are checked at tenant and account scope (plans are not event-scoped) before plan creation
and subscription. `listMembershipPlans` omits plans whose families are disabled for the viewer,
so no price surfaces.

## Model (`0053_subscriptions.sql`)

* `membership_plans` — creator (`tenant` / `participant` / `account`), price, currency,
  `billing_interval` (`month`/`year`), `terms_version`, status.
* `subscriptions` — status `incomplete → active ⇄ past_due → cancelled | expired`, current period,
  `cancel_at_period_end`, **consent evidence** (`consent_terms_version`, price, currency, interval,
  `consent_at`), provider subscription id. One live subscription per account per plan.
* `subscription_history` — append-only transitions.

## Consent

`subscribe` requires `consent: {accepted: true, termsVersion, priceMinor, currency, interval}` that
matches the plan exactly (`consent_required`, `consent_terms_conflict`, `consent_price_conflict`).
Consent is stored and audited (`subscription.consent_recorded`) before any provider call. A creator
cannot subscribe to their own plan.

## Lifecycle (provider-driven)

| Event | Effect |
| --- | --- |
| `checkout.session.completed` (subscription) | links the provider subscription id |
| `invoice.paid` | records a `subscription` payment order (ledger + split to the creator as `payee`), status → `active`, period advanced, `content.view` grant with `starts_at/expires_at` = the paid period |
| `invoice.payment_failed` | `active → past_due` (access continues only until the paid period ends) |
| `customer.subscription.deleted` | `cancelled` (or `expired` if it lapsed unpaid); grants beyond now revoked |
| `checkout.session.expired` | `incomplete → expired` |

Invoices can arrive before checkout completion; the subscription is found via the
`subscription_data.metadata` we set (`organization_id`, `subscription_id`). Replayed invoices are
deduplicated by the order idempotency key `invoice:<id>` in addition to webhook event ids.

Cancellation (`POST …/subscriptions/{id}/cancel`, subscriber or `tenant.manage`):
`atPeriodEnd: true` (default) asks the provider for `cancel_at_period_end`, access continues to the
end of the paid period; `false` cancels now and revokes access. A fully refunded subscription
payment ends the access it paid for. `expireLapsedSubscriptions` (scheduled job) expires
subscriptions 7 days past their period end if no provider event arrived.

`hasActiveSubscription(org, account, plan)` = live status, inside the current period, and an
active `content.view` grant sourced from that subscription.

## API

| Route | Method | Authorization |
| --- | --- | --- |
| `/api/organizations/{org}/membership-plans` | GET | member |
| `/api/organizations/{org}/membership-plans` | POST | own `account` plan: member; otherwise `tenant.manage` |
| `/api/organizations/{org}/membership-plans/{planId}/archive` | POST | `tenant.manage` |
| `/api/organizations/{org}/membership-plans/{planId}/subscriptions` | POST (`Idempotency-Key`, `consent`) | member |
| `/api/organizations/{org}/subscriptions` | GET | member (own) |
| `/api/organizations/{org}/subscriptions/{subscriptionId}/cancel` | POST `{atPeriodEnd}` | subscriber or `tenant.manage` |

## Not claimed

Proration, plan changes, trials, dunning emails, tax and customer portal are not implemented.
