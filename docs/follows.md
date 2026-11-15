# LC-12 Follows and audience relationships

Members follow **profiles** (competitors), **events** (competitions) and the **tenant**.
Gated by the LC-08 `follows` feature (checked before any side effect, fail closed).

## Model

`follows` (migration `0013_follows.sql`): `target_type` ∈ {profile, competition,
organization} with typed nullable `profile_id` / `competition_id` columns carrying composite
tenant FKs (a CHECK enforces exactly the right column per type). A unique expression index
on `(organization_id, follower_account_id, target_type, target)` makes follow idempotent
(`INSERT ... ON CONFLICT DO NOTHING`), so concurrent follows yield one row. The follower is a
composite FK to `organization_memberships` (member-only).

`notify_consent` defaults to **false**. It changes only through an explicit consent call that
stamps `notify_consent_at` and writes an audit event
(`follow.notification_consent_granted|withdrawn`). Unfollowing a consented follow audits a
withdrawal. Repeating the current value is a no-op.

## Privacy

No API returns follower identities. Members can list **their own** follows; anyone may read a
**count** for a target they can see. `listConsentedFollowers()` (server-only, not routed)
returns consenting, still-active members for future notification dispatchers.

Target visibility: profiles must be unhidden with an active owner and visible to the viewer
(public, members-only for members, or own); events must not be drafts and (since LC-13) must be
`public`, or `members` for a member viewer; the tenant target must be the same tenant.

## HTTP

| Route | Method | Auth |
| --- | --- | --- |
| `/api/organizations/{org}/follows` | GET (own follows), POST `{targetType,targetId}` (201 new / 200 existing), DELETE `?targetType&targetId` | active member |
| `/api/organizations/{org}/follows/consent` | PUT `{targetType,targetId,notify}` | active member |
| `/api/organizations/{org}/follows/count?targetType&targetId` | GET | optional member |
| `/api/public/organizations/{org}/follows/count?targetType&targetId` | GET | anonymous |

Errors: `invalid_follow_target` 400, `follow_target_not_found` 404 (hidden, draft or other
tenant), `follow_not_found` 404, `feature_disabled` 403.

## Tested

`packages/db/src/follows.test.ts`: concurrent idempotent follow, unfollow idempotency, consent
audit + recipient list, visibility rules, cross-tenant rejection, feature-disabled failure.
Handler tests in `apps/web/src/app/api/organizations/[organizationId]/follows/handler.test.ts`.

## Not implemented

Actual notification delivery (LC notifications/email milestones), follower export for operators.
