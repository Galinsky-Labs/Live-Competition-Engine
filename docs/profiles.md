# LC-10 Public profiles

Generic performer / producer / judge profiles with visibility, moderation and
linked history derived from published results.

## Model

* `profiles` (migration `0012_public_profiles.sql`): tenant-scoped, one profile per
  `(organization_id, owner_account_id)`. Composite FK to `organization_memberships`;
  a trigger rejects writes unless the owner's membership is **active**. Bounded fields:
  `display_name` 1–100 chars, `bio` ≤ 2000, `roles` ⊆ {performer, producer, judge},
  `visibility` ∈ {public, members, private}. `revision` is the optimistic-concurrency
  counter. `hidden_at / hidden_by_account_id / hidden_reason` record operator moderation.
* `participants.account_id` (nullable, composite FK to memberships) links a participant
  record to a member account. Only `tenant.manage` can set it, and it is audited.
* Pure rules (projection, owner-only edit, mass-assignment rejection) are in
  `packages/profiles`. `packages/db/src/profiles.ts` provides the PostgreSQL
  `ProfileStore` whose `compareAndSet` is a single `INSERT ... ON CONFLICT DO NOTHING` or
  `UPDATE ... WHERE revision = $expected`, with `recordAudit` in the same transaction.

## Linked history

Derived on read, never client-supplied: events that have a `results` row with status
`final` for an entry whose participant is linked to the owner, and whose event status is
`published | live | paused | completed`. From LC-13 on, only events with
`visibility = 'public'` are published in the history (others are filtered by the projection,
including for the owner).

## HTTP

| Route | Method | Authorization |
| --- | --- | --- |
| `/api/organizations/{org}/profiles` | GET | optional member; anonymous only if `public_profiles` is on |
| `/api/organizations/{org}/profiles/{profileId}` | GET | optional member (projection by visibility) |
| `/api/organizations/{org}/profiles/{profileId}` | PUT | active member, owner only. No `If-Match` = create (201); `If-Match: "<revision>"` = update. Returns `ETag`. |
| `/api/organizations/{org}/profiles/{profileId}/moderation` | POST `{hidden, reason?}` | `tenant.manage` |
| `/api/organizations/{org}/participants/{participantId}/account` | PUT `{accountId \| null}` | `tenant.manage` |
| `/api/public/organizations/{org}/profiles[/{profileId}]` | GET | anonymous; requires `public_profiles` |

Pages: `/t/{organizationSlug}/profiles` and `/t/{organizationSlug}/profiles/{profileId}`
(server-rendered, semantic headings/lists, no external assets).

**Feature flag choice:** member-facing reads are not gated. Anything anonymous (public
API and pages) requires the LC-08 `public_profiles` flag, so a tenant opts in to internet
exposure; when off, anonymous detail returns 404 and listing 403 `feature_disabled`.

## Failure modes

`profile_revision_conflict` 409 (stale revision, concurrent edit, or second profile for the
same owner), `forbidden` 403 (not the owner, suspended/non-member owner), `invalid_profile`
400, `profile_not_found` 404 (including any cross-tenant id). Hidden profiles and profiles of
suspended members are visible only to their owner.

## Tested

`packages/db/src/profiles.test.ts`: create/edit/visibility matrix, concurrent compare-and-set
(one winner), cross-tenant read/write/moderation denial, suspended owner, history derivation
(final vs provisional, draft events), moderation + audit chain, keyset paging.
Handler tests: `apps/web/src/app/api/organizations/[organizationId]/profiles/handler.test.ts`.

## Not implemented

Avatars/media on profiles, profile deletion/export, search.
