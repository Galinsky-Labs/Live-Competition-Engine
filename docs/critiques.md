# Critiques and feedback (LC-21)

Optional capability, feature flag `critiques` (checked with audit before every read and write; a disabled
flag returns 403 to members and 404 on the anonymous endpoint). Judges write one critique per performance,
either **private** (delivered to the entrant only) or **public** (published after producer approval).
Entrants read their own critiques and can file appeals or correction requests; producers resolve them.

## Layers

| Layer | Location |
| --- | --- |
| Domain | `packages/domain/src/critiques.ts` — critique and appeal state machines, visibility rules, bounds |
| Schema | `packages/db/migrations/0024_critiques.sql` — `critiques`, `critique_events` (append-only), `critique_appeals`, `critique_appeal_events` (append-only) |
| Service | `packages/db/src/critiques.ts` |
| HTTP | `.../competitions/{id}/critiques/**`, `.../judging/critiques`, `.../rounds/{roundId}/performances/{performanceId}/critique`, public `GET /api/public/organizations/{org}/competitions/{id}/critiques` |
| Pages | judge critique panel on `/judging`; producer queue on `/moderation`; entrant `/console/{org}/competitions/{id}/feedback` |

## Critique lifecycle

```
draft ──submit──▶ delivered            (private)            ──producer retract──▶ retracted
draft ──submit──▶ pending_moderation   (public) ──producer──▶ published ──retract──▶ retracted
                                                 └─producer─▶ rejected ──judge edits──▶ draft
draft | pending_moderation ──judge──▶ withdrawn
```

* Writing and submitting require the judge access check from LC-19 (verified, on the round panel, not recused).
* Optimistic `expectedRevision` on every change (409 `critique_revision_conflict`); two producers moderating the
  same critique → one conflict. A critique's author can never moderate it (403 `self_approval_forbidden`).
* Returning (reject) and retracting require a reason; every transition is in `critique_events` and the audit log.
* One current critique per judge per performance; withdrawn/retracted ones free the slot.

## Visibility

* Entrant (`GET critiques/mine`, any member): delivered and published critiques of entries whose participant
  is linked to their account (`participants.account_id`). Judge identity is not disclosed.
* Public (`GET /api/public/.../critiques`, no auth, `cache-control: public, max-age=30`): published public critiques of
  non-draft competitions — entrant display name, round label, body, publication time.
* Producers see everything except drafts.

## Appeals and correction requests

`open → under_review → upheld | dismissed`, `open → upheld | dismissed`, `open | under_review → withdrawn` (entrant).
One open request per critique (409 `appeal_pending_conflict`). Resolutions need a reason the entrant can read;
upholding with `retract: true` also retracts the critique. The critique's author cannot resolve appeals against it.
Every step is in the append-only `critique_appeal_events` trail (returned with each appeal) and in the audit log.

## Tested

Domain: full transition tables for critiques and appeals, visibility helpers, bounds. Integration: private delivery,
draft privacy, public moderation with rejection/revision/publication, public listing and draft-competition hiding,
self-moderation refusal, concurrent moderation, appeals (ownership, one-open, review, uphold + retract, withdraw),
retraction, recused judge refusal, feature flag fail-closed, cross-tenant negatives, append-only trail, audit chain.
Handlers: role separation (judge/producer/member), 201/403/404/409/400 mapping, anonymous public projection.

## Not claimed

No notifications to entrants, no rich text, no automated content moderation (human moderation only).
