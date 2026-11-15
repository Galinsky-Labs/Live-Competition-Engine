# LC-33 Ticketing, PPV and entry fees

Status: implemented and integration-tested with the fake payment provider. No real ticket sale
has been made; sample prices are not revenue.

## Feature flags (independent)

| Family | Feature key | Gate |
| --- | --- | --- |
| Event entry tickets | `ticketing` | `event.enter` grant |
| Pay-per-view streams | `ppv` | `event.view` grant |
| Competition entry fees | `entry_fees` | `hasPaidEntryFee(org, competition, account)` |

Each is checked with `requireEnabledFeature(feature, {organizationId, eventId, accountId})`
before any side effect (type creation, purchase, fee configuration), so it can be vetoed at
platform, tenant, event or account scope. When a family is disabled:

* `listTicketTypes` omits that kind entirely (no price surfaces in the API or the public page);
* `checkEventAccess` returns `{gated:false, allowed:true}` (the paywall disappears, it does not block);
* `entryFeeGate` returns `{required:false}` (no price).

Integration tests veto at event (ticketing, entry_fees), account (ppv) and tenant (ppv) scope and
show the other family unaffected. The platform scope is a single shared row; it is covered by the
LC-08 feature tests and by handler tests (`feature_disabled` → 403) rather than toggled in DB
tests, because flipping it would race with concurrently running test files.

## Model (`0052_ticketing.sql`)

* `ticket_types` — per event: kind (`ticket`/`ppv`), price, currency, optional capacity, sales
  window, status (`on_sale`/`paused`/`archived`), `reserved` counter with
  `CHECK (reserved <= capacity)`.
* `ticket_reservations` — one per order: `held → issued | released`, `issued → refunded | revoked`.
  Partial unique index: one live (held/issued) ticket per account per ticket type.
* `entry_fees` — one optional fee per competition (optimistic `revision`).
* `entitlement_grant_sources` — provenance for every grant issued by monetization flows.

## Purchase flow

1. Feature check, sales window check.
2. One transaction: idempotent `payment_orders` insert → conditional
   `UPDATE ticket_types SET reserved = reserved + 1 WHERE reserved < capacity` (row lock; the CHECK is
   the backstop) → reservation row with a 40-minute hold.
3. Free (price 0): order completes immediately (`provider = none`), grant issued, no provider
   call and no ledger posting.
4. Paid: Stripe Checkout Session with `expires_at` = now + 35 min, so a session can never be paid
   after its hold lapsed. The buyer is redirected; only the signed webhook completes the order.
5. On `payment_succeeded`: split posting (LC-32), reservation `issued`, grant
   (`event.enter` or `event.view`, source `ticket`) issued in the same transaction.
6. On failure/cancel/expiry: hold released. `releaseExpiredHolds` (scheduled via
   `POST /api/platform/jobs/payments` with `Authorization: Bearer $JOB_WORKER_SECRET`) cancels unpaid
   orders whose hold expired.
7. On full refund: grant → `refunded`, seat released. Partial refunds keep the ticket.
   `revokeTicket` revokes without refund.

Concurrency test: 12 buyers race for 3 seats → exactly 3 orders, 9 `sold_out`; a buyer racing
two purchases gets one.

## Entry fees

Entry fees are payment orders with `purpose = 'entry_fee'` referencing the competition and the
account; they do not depend on any application table. Application flows call
`entryFeeGate(org, competition, account)` (or `hasPaidEntryFee`) and require `paid` only when
`required` is true. A fully refunded fee no longer counts as paid.

## API

| Route | Method | Authorization |
| --- | --- | --- |
| `…/competitions/{competitionId}/ticket-types` | GET | member (enabled families only) |
| `…/competitions/{competitionId}/ticket-types` | POST | `event.manage` |
| `…/competitions/{competitionId}/ticket-types/{ticketTypeId}` | PATCH `{status, expectedRevision}` | `event.manage` |
| `…/competitions/{competitionId}/ticket-types/{ticketTypeId}/orders` | POST (`Idempotency-Key`) | member; account from session |
| `…/competitions/{competitionId}/access?mode=enter\|view` | GET | anonymous or member |
| `…/competitions/{competitionId}/entry-fee` | GET (gate), PUT (configure) | member / `event.manage` |
| `…/competitions/{competitionId}/entry-fee/orders` | POST (`Idempotency-Key`) | member |
| `/api/platform/jobs/payments` | POST | `JOB_WORKER_SECRET` bearer |

(`…` = `/api/organizations/{organizationId}`.)

Pages: `/checkout/{organizationId}/events/{competitionId}` (public listing of enabled ticket
types), `/checkout/{organizationId}/return` and `/checkout/{organizationId}/cancelled` (hosted
checkout landing pages; they show no payment state because they cannot authenticate).

## Not claimed

Seat maps, multi-quantity orders (one ticket per order/account per type), transfers, QR
scanning, and waitlists are not implemented.
