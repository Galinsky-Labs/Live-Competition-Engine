# LC-32 Revenue-split engine

Status: implemented; pure allocation logic property-tested; ledger postings integration-tested
with the fake provider. Sample amounts in tests are not revenue.

## Rules

`revenue_split_rules` rows are **immutable versions** scoped to (tenant, optional event,
optional purpose). Publishing increments the version under an advisory lock; UPDATE/DELETE are
blocked by trigger. Resolution precedence for an order: `(event, purpose)` → `(event, *)` →
`(*, purpose)` → `(*, *)` → default rule (100 % to the order's payee if it has one, else the
tenant).

Each line: `partyType` (`platform`, `tenant`, `promoter`, `performer`, `rights_owner`, `payee`),
`partyId` (required for promoter/performer/rights_owner), `bps` (0–10000, total ≤ 10000) and
`fixedMinor`. `payee` resolves at allocation time to the order's beneficiary (tip recipient,
subscription creator). `remainderLine` (defaults to the tenant line) receives all rounding dust.

### Allocation (`packages/domain/src/revenue-split.ts`)

1. Fixed amounts in line order, each capped at what is still unallocated.
2. Percentages of the amount left after fixed amounts, floored per line.
3. The remainder goes to `remainderLine`.

Property tests (3 000 random rules/amounts) prove: parts sum exactly to gross, no part is
negative, the function is deterministic. Refunds use `refundAllocationDelta` (cumulative floor
with the remainder line absorbing rounding): any sequence of partial refunds returns exactly the
original allocations when fully refunded (tested over 500 random sequences).

## Ledger

On payment success (`splitHooks.onSucceeded`) one `split` transaction moves the gross from
`sales_clearing` to `platform_revenue`, `tenant_revenue` and `payable:<type>:<id>` accounts; the
allocation snapshot is stored in `payment_allocations` (one active row per order). Refunds debit
those accounts proportionally and credit `provider_clearing`.

**Adjustments** (`adjustSplit`): reverse the active split transaction (reversal entry), mark the
allocation superseded, repost with the chosen rule version. Refused once any refund succeeded or
is pending (`invalid_state_refunded`, `invalid_state_refund_pending`), so allocation math never
mixes rule versions.

**Payout statements** (`payoutStatement`): opening balance, entries and closing balance for one
party account and currency in a window; `owedMinor = −closing` (liabilities are credits).
Actual payouts to bank accounts are not implemented.

## API (tenant.manage)

| Route | Method |
| --- | --- |
| `/api/organizations/{org}/revenue-splits[?eventId=]` | GET, POST `{eventId?, purpose?, lines, remainderLine?}` |
| `/api/organizations/{org}/payments/orders/{orderId}/split-adjustments` | POST `{ruleId}` |
| `/api/organizations/{org}/payouts/statement?partyType=&partyId=&currency=&from=&to=` | GET |

## Tests

`packages/domain/src/revenue-split.test.ts`, `packages/db/src/revenue-splits.test.ts` (versioning
and concurrent publish, precedence, split posting, proportional partial/full refunds to zero,
adjustment via reversal, payout statement, cross-tenant denial),
`apps/web/.../revenue-splits/handler.test.ts`.
