# LC-46 Moderation and trust/safety

Reporting, a triage queue, generic takedowns, appeals, evidence, legal holds and rate limits.
Moderation is core (no feature flag): it must work even when optional features are off.

## Storage (migration `0062_moderation.sql`)

| Table | Notes |
| --- | --- |
| `moderation_reports` | Any subject: `profile`, `chat_message`, `media`, `critique`, `page`, `event` (`subject_id` is text so non-UUID ids work). Reporter is a member account or anonymous; both are keyed by a SHA-256 `reporter_key` (anonymous: tenant + client address). One unresolved report per reporter per subject (partial unique index → idempotent resubmission). Optimistic `revision`. |
| `moderation_report_transitions` | Append-only history of every status change (UPDATE blocked by trigger). |
| `moderation_actions` | Generic `hide` / `takedown` on `(subject_type, subject_id)`, optional report and affected account. Reversal sets `reversed_*`; rows are never deleted while held. |
| `moderation_appeals` | One appeal per action, only by the action's `affected_account_id`. `open → upheld | overturned`; overturned reverses the action. |
| `moderation_evidence` | Text, or a media reference (composite FK to LC-11 `media_library` in the same tenant). |
| `moderation_legal_holds` | Active hold per subject. A trigger refuses DELETE of reports, actions and evidence for a held subject (`legal_hold_active`). |
| `rate_limit_counters` | Generic fixed-window limiter (`packages/db/src/rate-limit.ts`, `consumeRateLimit`). Atomic upsert never admits more than the limit. |

Report state machine (`packages/domain/src/moderation.ts`): `open → triaged | actioned | dismissed`,
`triaged → actioned | dismissed`; `actioned` and `dismissed` are terminal. `actioned` is reached only by
taking an action with `reportId` (atomic). Rate limits: members 20 reports/hour, anonymous 5/hour per tenant.

## Integration points for other modules

* `isSubjectHidden(organizationId, subjectType, subjectId)` — true when an unreversed action exists.
  Fails closed (true) for a malformed tenant id. CMS public rendering (LC-45) consults it.
* `isUnderLegalHold(organizationId, subjectType, subjectId)` — call before deleting a subject's data.
* `moderationOverviewCounts` feeds the LC-43 admin overview.

## HTTP (`/api/organizations/{org}/moderation/...`)

| Method | Path | Who |
| --- | --- | --- |
| POST | `reports` `{subjectType, subjectId, reason, details?}` | member (session identity) or anonymous |
| GET | `reports?status` | `tenant.manage` |
| GET, DELETE | `reports/{reportId}` (DELETE only dismissed reports without actions; refused under hold) | `tenant.manage` |
| POST | `reports/{reportId}/transition` `{to, note?, expectedRevision}` | `tenant.manage` |
| POST | `reports/{reportId}/evidence` `{kind: text|media, body?, mediaId?}` | `tenant.manage` |
| GET, POST | `actions` `{subjectType, subjectId, action, reason, reportId?, affectedAccountId?}` | `tenant.manage` |
| POST | `actions/{actionId}/reverse` `{reason}` | `tenant.manage` |
| GET | `actions/mine` | member (actions affecting them) |
| POST | `actions/{actionId}/appeals` `{statement}` | the affected member |
| GET | `appeals?status` | `tenant.manage` |
| POST | `appeals/{appealId}/decision` `{decision: upheld|overturned, note?}` | `tenant.manage` (not the appellant) |
| POST, DELETE | `holds`, `holds/{holdId}` | `tenant.manage` |

Every decision writes `recordAudit` (`moderation.*`) in the same transaction.

Page: `/admin/{org}/moderation` (read-only queue, active actions, open appeals).

## Not claimed

* Anonymous rate limiting keys on `X-Forwarded-For`/`X-Real-IP`; it is only meaningful behind a proxy that
  overwrites those headers. Without one, anonymous limits are best effort.
* No automated classifiers; no notifications to reporters/affected accounts yet (LC-47 can be wired).
* Legal-hold deletion protection covers moderation tables; other modules must call `isUnderLegalHold`.
