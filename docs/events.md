# LC-13 Event creation

Competitions are events. LC-13 extends `competitions` (migration `0014_events.sql`) with:
`slug` (unique per tenant, `^[a-z0-9](-?[a-z0-9])*$`, ≤ 64), `timezone` (IANA, validated with
the runtime tz database), `capacity` (1–1,000,000), `venue_name`/`venue_address` and/or an
`https` `stream_url` (no embedded credentials), `visibility` (public | members | private,
default private), `revision`, `published_at`, `cancelled_at` + `cancel_reason`,
`created_by_account_id`. `competition_status_history` is an append-only log of transitions.

## Lifecycle (pure state machine: `packages/domain/src/events.ts`)

| From | Allowed to |
| --- | --- |
| draft | published, cancelled |
| published | live, completed, cancelled |
| live | paused, completed, cancelled |
| paused | live, completed, cancelled |
| completed, cancelled | — (terminal, read-only) |

* Publishing requires a slug, `startsAt`, and a venue or stream URL; once published those stay
  required and the **slug is locked** so public URLs are stable.
* Cancelling requires a reason (1–1000 chars); it is published on the public projection.
* Every transition locks the row (`FOR UPDATE`), checks `If-Match` revision, bumps `revision`,
  writes `competition_status_history` and `recordAudit("event.status_changed")`.
  Edits write `event.updated`; creation writes `event.created`.

## Authorization

| Operation | Check |
| --- | --- |
| Create, manage listing (`?view=manage`) | `event.manage` at tenant scope (tenant operators) |
| Read full record, edit, transition | `event.manage` with `competitionId` (producer grant or tenant operator) |
| Member listing | optional member; members also see `members` events |
| Public detail/listing | anonymous; `public` visibility and non-draft status only |

## HTTP

* `GET|POST /api/organizations/{org}/competitions`
* `GET|PATCH /api/organizations/{org}/competitions/{competitionId}` (PATCH requires `If-Match`, else 428)
* `POST /api/organizations/{org}/competitions/{competitionId}/transitions` `{ to, reason? }` + `If-Match`
* `GET /api/public/organizations/{org}/competitions[/{idOrSlug}]`

Pages: `/t/{organizationSlug}/events` (listing) and `/t/{organizationSlug}/events/{eventSlug}`
(detail with times rendered in the event's time zone, `<time datetime>`, `<dl>`, cancellation
notice with `role="status"`).

Errors: `event_revision_conflict` 409, `invalid_state_transition` / `invalid_state_slug_locked` /
`invalid_state_event_closed` 409, `event_slug_conflict` 409, `cancel_reason_required`,
`event_not_publishable_*`, `invalid_*` 400, `event_not_found` 404, `if_match_required` 428.

Follows (LC-12) and profile history (LC-10) honour event visibility.

## Tested

Domain: transition matrix, publish/cancel preconditions, field validation, slug lock.
Integration (`packages/db/src/events.test.ts`): full lifecycle with history + audit chain,
cancellation, slug uniqueness per tenant, a four-way race at one revision (exactly one wins),
cross-tenant read/update/transition denial, visibility of listings. Handler tests cover
403/400/404/409/428.

## Not implemented

Recurring events, ticketing/capacity enforcement (capacity is informational until ticketing),
event deletion.
