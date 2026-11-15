# LC-36 Tips and live gifts

Status: implemented and integration-tested with the fake provider. No real tips have been
processed; sample amounts are not revenue.

## Feature

`tips_gifts`, checked at tenant, event and sender-account scope (platform via LC-08) before every
quote, tip and catalog change. Disabled → quotes/tips fail with `feature_disabled` (403), the gift
catalog and the event tip feed are empty (no prices surface).

## Model (`0055_tips_gifts.sql`)

* `gift_catalog` — tenant-defined priced gifts.
* `tip_policies` — per-tenant min/max amount, rolling window, max tips and max amount per window
  (defaults: 1.00–500.00 minor-unit equivalents, 10 tips / 1 000.00 per hour).
* `participant_payout_accounts` — which member account receives a participant's payouts; used to
  block self-tipping.
* `tips` — sender, payee (`participant` with an entry in the event, or a member `account`), gift
  and quantity, amount, the quoted payee amount, optional message (≤ 280 chars), payment order.

## Flow

1. `POST …/competitions/{competitionId}/tips/quote` → `{grossMinor, payeeMinor, fees[], ruleVersion}`
   computed from the **same split rule** (purpose `tip` or `gift`, LC-32) that will post the ledger.
2. `POST …/competitions/{competitionId}/tips` with `acceptedQuote: {grossMinor, payeeMinor}` and an
   `Idempotency-Key`. The server recomputes the quote; any difference → `quote_changed` (409).
3. Under a per-sender advisory lock, velocity (count and amount in the window, excluding
   failed/cancelled orders) is checked → `rate_limited` (429). Then the order and tip row are created
   and a hosted checkout is returned.
4. On the verified payment event the split hook credits `payable:<participant|account>:<id>` and
   fees to `platform_revenue` / `tenant_revenue`.
5. Refunds and chargebacks (`charge.dispute.created`) reverse proportionally out of the payee
   payable and fee accounts; reversed tips disappear from the feed.

Abuse prevention: self-tips are rejected (`self_tip_forbidden`, 403) both for `account` payees and
for participants whose payout account is the sender; amount bounds; per-window caps proven under
concurrency (6 parallel tips with a cap of 3 → exactly 3 accepted).

## API

| Route | Method | Authorization |
| --- | --- | --- |
| `/api/organizations/{org}/gifts[?eventId=]` | GET | member |
| `/api/organizations/{org}/gifts` | POST | `tenant.manage` |
| `/api/organizations/{org}/tip-policy` | PUT | `tenant.manage` |
| `/api/organizations/{org}/participants/{participantId}/payout-account` | PUT `{accountId}` | `tenant.manage` |
| `/api/organizations/{org}/competitions/{competitionId}/tips/quote` | POST | member |
| `/api/organizations/{org}/competitions/{competitionId}/tips` | POST (send), GET (settled feed) | member |

## Not claimed

Real-time overlay delivery of gifts (LC streaming/overlay modules), payouts to bank accounts and
KYC of payees are not implemented.
