# Applications and registration (LC-17)

Entrants apply to a competition through a producer-defined, bounded form. Producers review
submitted applications and decide; a selection creates the participant and entry rows.
Optional capability: feature flag `applications` (checked, with audit, before every write).

## Layers

| Layer | Location |
| --- | --- |
| Domain (pure) | `packages/domain/src/applications.ts` (+ vitest) — form schema, answer validation, window check, status machine, waitlist order, capacity |
| Schema | `packages/db/migrations/0020_applications.sql` |
| Service | `packages/db/src/applications.ts` (+ node:test integration tests) |
| HTTP | `apps/web/src/app/api/organizations/[organizationId]/competitions/[competitionId]/applications/**` |

## Form schema

`{ opensAt, closesAt, capacity|null, contactConsentKey|null, fields[] }`, at most 50 fields with unique
keys `^[a-z][a-z0-9_]{0,39}$`. Field types (closed set):

* `text` — `maxLength` 1..5000 (default 500), `multiline` (single-line rejects newlines/tabs); control characters rejected.
* `choice` — 1..50 unique options, `multiple`.
* `media` — up to `maxItems` (≤5) LC-11 `media_library` ids. Each must belong to the same tenant, be owned by
  the applicant and not be revoked; checked on every draft save and again on submit.
* `consent` — `consentVersion`; a required consent must be `true` to submit. On submit each accepted consent is
  stored append-only in `application_consents` with key, version, account and timestamp.

Unknown answer keys are rejected. Drafts may be partial; submit requires all required fields.

## Status machine

```
draft ──submit(applicant)──▶ submitted ──▶ under_review ──▶ selected | waitlisted | declined
  │                             │ (producer may also decide directly from submitted)
  └─withdraw(applicant)         waitlisted ──▶ selected (producer or system promotion) | declined
selected ──withdraw(applicant)──▶ withdrawn  (entry → withdrawn, next waitlisted is auto-selected)
declined ──reopen(producer, reason)──▶ under_review
```

Any status except `selected`/`declined`/`withdrawn` can be withdrawn by the applicant. `declined` and reopening
require a reason (≤1000 chars). Every transition writes a row to the append-only `application_decisions`
(revision, actor kind/account, previous/new status, reason, time) and an `application.<status>` audit event.

## Rules enforced server-side

* Window: create, edit and submit only when `opensAt ≤ now < closesAt` (`application_window_not_open`,
  `application_deadline_passed`). Withdrawal is always allowed.
* One active (non-withdrawn) application per account per competition (partial unique index). `POST` is
  idempotent: it returns the existing application with 200 instead of creating a duplicate (201).
* Submit is idempotent: re-submitting an already submitted application returns it unchanged.
* Edits only while `draft`, with `expectedRevision` (stale → 409 `application_revision_conflict`).
* Producer decisions lock the form row (serializes capacity and waitlist numbering per competition) and
  compare `expectedRevision`; two producers deciding the same revision → exactly one succeeds, the other gets 409.
  Batches (`bulk-decisions`, ≤100) are all-or-nothing.
* Capacity: selecting beyond `capacity` → 409 `selection_capacity_conflict`.
* Waitlist: positions are assigned in decision order; promotion takes the lowest position.
* Selection creates (or reuses) a `participants` row linked by `participants.account_id` (nullable FK to the
  tenant membership) and an `approved` entry; an applicant's withdrawal marks the entry `withdrawn`.

## Privacy

Producers never see drafts. The review projection contains display name, answers, consents, media ids and
status data; the applicant's email is included **only** if they accepted the form's `contactConsentKey`
consent. Media playback still goes through the LC-11 media API and its owner-only rules (producers receive ids only).
Another account's application is reported as `application_not_found` (404), never 403.

## API (event-scoped prefix `/api/organizations/{org}/competitions/{competition}`)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET applications/form` | member | Read the form |
| `PUT applications/form` | `event.manage` | `{form, expectedRevision}` (0 = create) |
| `POST applications` | member | `{displayName, answers?}` start draft (201) or return active (200) |
| `GET applications/mine` | member | Own latest application |
| `GET/PATCH applications/{id}` | owner (member) | Read / edit draft `{displayName?, answers?, expectedRevision}` |
| `POST applications/{id}/submit` | owner | `{expectedRevision}` |
| `POST applications/{id}/withdraw` | owner | `{expectedRevision, reason?}` |
| `GET applications?status=&limit=&offset=` | `event.manage` | Review queue (waitlist ordered by position) |
| `GET applications/{id}/review` | `event.manage` | Review projection |
| `GET/POST applications/{id}/decisions` | `event.manage` | History / `{status, reason?, expectedRevision}` |
| `POST applications/bulk-decisions` | `event.manage` | `{decisions:[{applicationId,status,reason?,expectedRevision}]}` |

## Tested

Domain: schema bounds, answers, window edges, the full transition table, waitlist order, capacity.
Integration: happy path with consent/media/contact disclosure, idempotent create and submit, deadline,
concurrent producer decisions (one conflict), concurrent creates (single row), capacity + waitlist promotion,
cross-tenant read/decide/media negatives, other-applicant negative, feature flag fail-closed, append-only history,
audit chain validity. Handlers: 201/200, 401/403, 404 ids, 400 input, domain→HTTP mapping, identity from principal.

## Not claimed

No applicant-facing page yet (API only); no notification emails; producers cannot reorder the waitlist manually
(they select explicitly instead); form changes after submission do not re-validate existing submissions.
