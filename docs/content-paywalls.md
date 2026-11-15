# LC-35 Creator content and paywalls

Status: implemented and integration-tested (fake provider for purchases).

## Principles

* **No mandatory paid features.** Public items need no feature flag and are always served in
  full; a creator can always publish free.
* Gating is optional (`content_paywalls`) and evaluated at tenant, event (items linked to an
  event, e.g. archives), viewer-account and creator-account scope.
* **Fail closed without surfacing a gate:** when paywalls are disabled for an item, its gated
  content is *hidden* (404 / omitted from lists). It is never given away and no price, plan or
  purchase offer is returned.

## Model (`0054_content_paywalls.sql`)

`gated_content`: creator (`tenant` / `participant` / `account`), optional event, `kind`
(`text` with `body`, or `media` referencing an LC-11 `media_library` id), `title`, `teaser`,
`access_rule` (`public`, `members`, `plan` + `plan_id`, `purchase` + price/currency), status.
CHECK constraints keep rule and fields consistent; FKs are tenant-composite.

## Access rules (entitlement-backed)

| Rule | Full access when |
| --- | --- |
| `public` | always |
| `members` | the viewer has a live subscription (current period) to **any** plan of the same creator, backed by an active `content.view` grant sourced from that subscription |
| `plan` | `hasActiveSubscription(org, viewer, planId)` (status, period and grant) |
| `purchase` | a succeeded, not fully refunded `content` order for the item **and** an active `content.view` grant sourced from that order |

Creators (own account items) and `tenant.manage` holders always see full content. Otherwise the
API returns a teaser projection (`title`, `teaser`, `access: "teaser"`, `offer`) without
`body`/`mediaId`.

Purchase grants: LC-09 has no `purchase` grant source, so purchase grants use source `manual`
with provenance `payment_order:<orderId>` in `entitlement_grant_sources`, and this module always
filters grants by provenance. Note for integrators: the generic LC-09 entitlement endpoint sees
such a grant as tenant-wide `content.view`; use the paywall API for item decisions (see the
final report's request to add a scoped `purchase` source).

## API

| Route | Method | Authorization |
| --- | --- | --- |
| `/api/organizations/{org}/content[?eventId=]` | GET | anonymous or member |
| `/api/organizations/{org}/content` | POST | own `account` content: member; else `tenant.manage` |
| `/api/organizations/{org}/content/{itemId}` | GET | anonymous or member (404 when hidden) |
| `/api/organizations/{org}/content/{itemId}/purchases` | POST (`Idempotency-Key`) | member |

## Tests

`packages/domain/src/paywalls.test.ts`, `packages/db/src/paywalls.test.ts` (free vs teaser vs
full, supporter and plan access, purchase unlock and refund relock, purchase does not unlock other
items, event/creator-account/tenant vetoes hide gated items without price, cross-tenant denial),
`apps/web/.../content/handler.test.ts`.

## Not claimed

Signed media delivery for gated media is delegated to LC-11 playback (callers must check access
before issuing playback); no DRM, no time-limited rentals.
