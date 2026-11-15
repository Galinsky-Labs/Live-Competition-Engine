# LC-47 Notifications

Job-backed in-app and email notifications with preferences, consent, retries, bounce handling
and per-tenant privacy isolation.

## Durable job queue (`packages/db/src/jobs.ts`, table `jobs`)

* Columns: `kind`, `payload` (≤64 KiB), `status` (`queued → running → succeeded | dead`, `cancelled`), `run_at`,
  `attempts`/`max_attempts`, `backoff_base_ms`, `lease_token`/`lease_expires_at`, `last_error`, `idempotency_key`
  (unique per tenant + kind).
* `claimJobs` selects due queued jobs and running jobs with expired leases using `FOR UPDATE SKIP LOCKED`, sets a
  fresh lease token and increments `attempts`. Expired leases that already used every attempt become `dead`.
* `completeJob`/`failJob` require the current lease token (a worker whose lease expired is fenced out).
* Retry policy (`packages/domain/src/jobs.ts`): exponential backoff with equal jitter, capped at 6 h; permanent errors
  (`PermanentJobError`, permanent provider errors) go straight to `dead`.
* `runJobs(handlers)` claims only kinds it has handlers for.

### Worker endpoint

`POST /api/jobs/run?limit=N` with `Authorization: Bearer <JOB_WORKER_SECRET>` (from `packages/config/src/providers.ts`).
Missing secret → 503 (fail closed); wrong secret → 401 (constant-time comparison). Each tick publishes due CMS
schedules (LC-45) and runs one batch of jobs. Call it from a cron (e.g. every minute).

## Notifications (`packages/db/src/notifications.ts`)

| Table | Notes |
| --- | --- |
| `notifications` | In-app inbox rows keyed by (tenant, account); composite FK to membership; unique idempotency key per recipient. |
| `notification_preferences` | Per (tenant, account, category, channel) with `source` (`preferences`, `unsubscribe_link`). |
| `email_messages` | Outbox: rendered email, status (`queued`, `sent`, `delivered`, `failed`, `suppressed`, `bounced`, `complained`), provider id, linked job and notification. |
| `email_suppressions` | Global address suppression (hard bounce, spam complaint, manual). Audited in the platform chain with a hashed address. |

Categories: `account`, `membership`, `event_updates`, `results`, `moderation`, `social`, `marketing`.
Channels: `in_app`, `email`. Default: on, except `marketing`, which is off on every channel until opted in.

`canNotify(org, account, category, channel)` is the single consent gate (pure rules in
`packages/domain/src/notifications.ts`): active membership → feature (`notifications` for in-app, `email` for email)
→ preference/default → for email, an address that is not suppressed. LC-12 follow consent does not exist yet;
category preferences are the consent record. `notify()` evaluates each channel separately, is idempotent, and
queues email via a `notification.email` job. The email job handler re-checks consent and suppression immediately
before sending; withdrawn consent marks the message `suppressed`.

### Email provider (`packages/db/src/providers/email.ts`)

* `createPostmarkProvider(requirePostmark())` — real adapter: `POST https://api.postmarkapp.com/email` with
  `X-Postmark-Server-Token`; 15 s timeout; header-injection refusal; 422 with recipient/content error codes is
  permanent, 429/5xx/network errors are transient (retried).
* `createFakeEmailProvider()` — deterministic test double. Tests with the fake prove our state handling, **not** Postmark delivery.

### Bounce/complaint webhook

`POST /api/webhooks/postmark`. Postmark does not HMAC-sign webhooks, so the endpoint requires the shared secret
`POSTMARK_WEBHOOK_SECRET` (≥32 chars) as HTTP Basic password — configure the webhook URL in Postmark as
`https://postmark:<secret>@<host>/api/webhooks/postmark` — or as `?token=<secret>` (less preferred: query strings
can end up in logs). Missing secret → 503. Hard bounces (`HardBounce`, `BadEmailAddress`, inactive, …) and
`SpamComplaint` suppress the address and mark the message; `Delivery` marks it delivered.

## HTTP

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/organizations/{org}/notifications?unread&limit` | member (own inbox) |
| POST | `/api/organizations/{org}/notifications/{notificationId}/read` | member |
| POST | `/api/organizations/{org}/notifications/read-all` | member |
| GET, PUT | `/api/organizations/{org}/notifications/preferences` `{preferences: [{category, channel, enabled}]}` | member |
| POST | `/api/organizations/{org}/notifications/send` `{accountIds ≤200, category ≠ marketing, title, body, link?, idempotencyKey}` | `tenant.manage` |
| POST | `/api/jobs/run` | worker secret |
| POST | `/api/webhooks/postmark` | webhook secret |

## Privacy isolation

Every inbox/preference query filters by `(organization_id, account_id)` from the session; the integration suite
proves an account that belongs to two tenants never sees the other tenant's notifications.

## Not claimed / requires coordinator

* `POSTMARK_WEBHOOK_SECRET` is read in `apps/web/src/lib/notification-services.ts` because `packages/config/src/providers.ts`
  is a shared file; it should be added there.
* `packages/config/src/providers.ts` uses a TypeScript parameter property, which Node's strip-only test runner cannot
  load, so `packages/db` does not import it; the web layer passes `requirePostmark()` into the adapter.
* Sending is at-least-once in theory: if a worker crashes after Postmark accepted a message but before recording it,
  the lease expires and the message can be sent again (Postmark has no idempotency key).
* Real Postmark delivery requires `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM_DEFAULT` in the environment.
