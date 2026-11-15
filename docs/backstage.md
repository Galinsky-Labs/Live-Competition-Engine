# Backstage and green room (LC-23)

Private, per-competition coordination between producers, performers and judges.
Migration `0031_backstage.sql`; pure rules `packages/domain/src/backstage.ts`; service
`packages/db/src/backstage.ts`; public lineup projection `packages/db/src/run-of-show.ts`;
HTTP under `apps/web/src/app/api/organizations/[organizationId]/competitions/[competitionId]/backstage/`.

## Roles (least privilege)

The caller's role is resolved from role grants scoped to the competition, most privileged first:

| Live role | Grant action | Sees | May post |
| --- | --- | --- | --- |
| producer | `event.manage` | everything | cues, judge-channel messages, entry links |
| judge | `judging.score` | judge channel only | judge-channel messages |
| performer | `performance.submit` | cues for entries they are linked to, their own check-ins and acks, the run-of-show | check-ins and cue acks for linked entries |

The core schema has no participant→account link, so producers declare which tenant member speaks
for an entry (`backstage_entry_accounts`, `POST .../backstage/links`). A performer grant alone does
not reveal any cue. Non-producers never receive other authors' account ids (`mine` flag instead).
A cue for someone else's entry is reported as `cue_not_found` (no existence oracle).

## Feed and polling

`backstage_messages` is append-only (trigger blocks UPDATE/DELETE). Each message gets a
per-competition `seq` assigned under a transaction-scoped advisory lock, so commit order equals
`seq` order and `GET .../backstage/messages?since=<cursor>` never skips a row. The response's
`cursor` is the competition-wide head seen in the same snapshot (or the last row when `hasMore`),
so clients poll with it unchanged. Page size 100. No websockets/SSE: poll every 1–3 s.

## API

| Method | Path | Body |
| --- | --- | --- |
| GET | `backstage/messages?since=N` | – |
| POST | `backstage/checkins` | `{ performanceId, readiness: "ready"\|"not_ready"\|"need_help", note?, idempotencyKey }` |
| POST | `backstage/cues` | `{ performanceId, body (1–280), idempotencyKey }` |
| POST | `backstage/cues/{cueId}/ack` | `{ idempotencyKey }` (once per performer per cue) |
| POST | `backstage/judge-messages` | `{ body (1–500), idempotencyKey }` |
| GET | `backstage/readiness` | producer only: latest check-in per performance and performer |
| POST | `backstage/links` | producer only: `{ entryId, accountId, linked }` |
| GET | `backstage/run-of-show` | any live role: rounds, performance order/status, public display names |

## Bounds and abuse controls

* Bodies trimmed, control characters rejected, length limits above; readiness enum.
* Rate limit: 20 messages per author per competition per 60 s → `429 rate_limited`.
* Idempotency key per tenant; replay by the same author returns the original message, a different
  author or kind → `409 idempotency_conflict`.
* Every post and link change is audited (`backstage.cue`, `backstage.checkin`, ...) without bodies.

## Tests

Domain visibility matrix and bounds (vitest); PostgreSQL integration: visibility per role,
ownership, double-ack conflict, idempotency, rate limit, 16 concurrent posts produce gap-free
seqs, cross-tenant reads/writes rejected (service and FK level); handler tests for role resolution,
401/403/400/404/429.

## Not implemented

Server-sent events, attachments, message retraction (feed is append-only by design), notifications.
