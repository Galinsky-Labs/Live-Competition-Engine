# LC-31 Payments and internal ledger

Status: implemented and tested against PostgreSQL with a deterministic fake provider and a
unit-tested Stripe adapter. **No real Stripe account has been exercised; nothing here
proves production payment behavior or represents actual revenue.**

## Model

| Table | Purpose |
| --- | --- |
| `ledger_accounts` | Tenant-scoped accounts per currency: `provider_clearing` (asset), `sales_clearing` (unallocated sales, liability), `platform_revenue`, `tenant_revenue` (revenue), `refunds`, `fees` (expense), `payable:<promoter\|performer\|rights_owner\|participant\|account>:<uuid>` (liability). Codes are validated by a CHECK. |
| `ledger_transactions` | Immutable journal header: one currency, kind (`payment`, `split`, `refund`, `reversal`, `adjustment`), tenant-unique idempotency key, optional `reverses_transaction_id` (at most one reversal per transaction). |
| `ledger_entries` | Integer minor-unit amounts, debits positive / credits negative, non-zero. |
| `payment_orders` | Explicit `status` (`requires_payment → processing → succeeded / failed / cancelled`) and `settlement_status` (`unsettled → settled → partially_refunded → refunded`). Idempotent per (tenant, account, key) with a request fingerprint. |
| `payment_order_history` | Append-only status transitions. |
| `payment_refunds` | `pending → succeeded / failed`; pending refunds reserve their amount. |
| `payment_webhook_events` | `(provider, event_id)` primary key = replay protection; payload stored only as SHA-256. |
| `payment_reconciliation_reports` | Stored reconciliation outcomes. |

### Invariants enforced by the database

* `ledger_assert_balanced()` runs as a **deferred constraint trigger** on both
  `ledger_transactions` and `ledger_entries`: each transaction must have ≥ 2 entries, sum to
  exactly zero and use a single currency (entry, account and transaction currency agree).
  The service runs `SET CONSTRAINTS … IMMEDIATE` after posting so violations surface at the call.
* `ledger_reject_mutation()` blocks `UPDATE`/`DELETE`/`TRUNCATE` on journal tables, ledger
  accounts and order history. Corrections are reversal transactions (`reverseLedgerTransaction`).
* Refund totals can never exceed the capture (`refunded_minor <= amount_minor` CHECK plus the
  order row lock in `requestRefund`).

## Postings

| Event | Lines |
| --- | --- |
| Payment succeeded | `provider_clearing +A`, `sales_clearing −A` |
| Refund (no split applied) | `sales_clearing +R`, `provider_clearing −R` |
| Refund (split applied, LC-32) | each allocation account `+share(R)`, `provider_clearing −R` |
| Chargeback (`charge.dispute.created`) | recorded as a `chargeback` refund of the remaining amount |

Free orders (amount 0) use provider `none`, never call a provider and post nothing.

## Provider integration

* Interface: `packages/db/src/providers/payments.ts` (`PaymentProvider`, normalized `PaymentEvent`).
* Stripe: `packages/db/src/providers/stripe.ts` — Checkout Sessions (`mode=payment` and
  `mode=subscription`), Refunds, subscription cancellation, charge listing; form-encoded bodies,
  `Idempotency-Key` on every write (`checkout:<orderId>`, `refund:<refundId>`), pinned
  `Stripe-Version: 2024-06-20`, credentials via `requireStripe()` (fails closed with
  `provider_not_configured` → HTTP 503).
* Webhook `POST /api/webhooks/stripe`: verifies `Stripe-Signature` (`t=…,v1=…`, HMAC-SHA256 over
  `${t}.${rawBody}`, constant-time compare, 300 s tolerance) **before** parsing, then stores the
  event id and applies it in one transaction. Replays return `{duplicate:true}`; processing
  errors roll back the event row so Stripe's retry is processed.
* Fake: `packages/db/src/providers/fake-payments.ts` (tests only).

Order state is never taken from the client: only verified provider events move an order to
`succeeded`. An event whose amount/currency differs from the order fails the order with
`amount_mismatch` (no fulfillment) and is left for reconciliation/operator refund. A success event
arriving for a failed/cancelled order is recorded as `invalid_state` and surfaces in reconciliation.

## Reconciliation

`reconcilePayments(org, provider, {since, until})` lists provider charges and compares
`captured − refunded` with the ledger `provider_clearing` net per order. Reported mismatch types:
`amount_mismatch`, `currency_mismatch`, `charge_without_settled_order`, `missing_at_provider`.
Charges not attributable to the tenant are counted (`unattributedChargeCount`) but not listed.
Nothing is auto-corrected. Provider fees are not yet imported (balance transactions are future work).

## API

| Route | Method | Authorization |
| --- | --- | --- |
| `/api/organizations/{org}/payments/orders/{orderId}` | GET | buyer or `tenant.manage` |
| `/api/organizations/{org}/payments/orders/{orderId}/cancel` | POST | buyer or `tenant.manage` (unpaid orders only) |
| `/api/organizations/{org}/payments/orders/{orderId}/refunds` | POST | `tenant.manage`; `Idempotency-Key` required |
| `/api/organizations/{org}/ledger` | GET | `tenant.manage` |
| `/api/organizations/{org}/ledger/reconciliations` | POST | `tenant.manage` |
| `/api/webhooks/stripe` | POST | Stripe signature |

Order projections never include provider references or request fingerprints.

## Feature flags

The payment core is infrastructure. Each monetization family (ticketing, ppv, entry_fees,
subscriptions, creator_memberships, content_paywalls, tips_gifts) gates its own purchase entry
points with `requireEnabledFeature` at platform/tenant/event/account scope. Refunds, ledger and
reconciliation remain available to operators after a family is disabled, so money already
collected can always be returned. Payments already captured when a family is disabled are still
fulfilled (the customer paid).

## Tests

* `packages/domain/src/money.test.ts` — balancing, account codes, proportional allocation (property style), state machines.
* `packages/db/src/payments.test.ts` — success, failure/cancel, amount mismatch, replayed and
  concurrent duplicate webhooks, idempotent orders, partial/full/concurrent refunds, pending and
  failed refunds, chargeback, DB-level imbalance/currency/mutation rejection, reversals,
  cross-tenant denial, reconciliation mismatches.
* `packages/db/src/stripe-provider.test.ts` — signature verification, event normalization, request encoding.
* `apps/web/src/app/api/webhooks/stripe/handler.test.ts`, `…/payments/handler.test.ts`.

## Not claimed

Real Stripe behavior, 3-D Secure flows, payouts to bank accounts, multi-currency FX, tax and
provider fee import are not implemented or verified.
