# Judge system (LC-19)

Producers invite judges per competition; an invited member accepts with a single-use code, which links a
judge record to their account and grants the competition-scoped `judge` role (`judging.score`). Producers
verify, suspend, reactivate or remove judges, manage recusals, and assign panels (LC-18). Judges only see
rounds where they sit on the active panel.

## Layers

| Layer | Location |
| --- | --- |
| Domain | `packages/domain/src/judges.ts` — email/lifetime/name bounds, invitation usability, lifecycle machine, view/score rules |
| Schema | `0021_selection.sql` (`competition_judge_states`, `judges.account_id` + membership FK + unique per tenant), `0022_judges.sql` (`judge_invitations`, `judge_recusals`) |
| Service | `packages/db/src/judges.ts` (incl. `assertPerformanceAccess`, used by scoring and critiques) |
| HTTP | `.../competitions/{id}/judges/**`, `.../competitions/{id}/judging/{assignments,conflicts}` |
| Pages | `/console/{org}/competitions/{id}/judges` (producer), `/console/{org}/competitions/{id}/judging` (judge) |

## Invitations

* Token: 32 random bytes (base64url, 43 chars) returned **once** in the `POST judges/invitations` response;
  only `sha256("judge-invite\0" + token)` is stored. Lifetime 1–720 hours (default 72).
* Re-inviting the same email revokes the previous open invitation (one open invitation per email per competition).
* Acceptance (`POST judges/invitations/accept {token}`, any active member): the invitation must belong to this
  tenant and competition, be unused, unrevoked and unexpired, and the account's email must equal the invited email
  (403 `invitation_email_mismatch`). The row lock makes it single use: concurrent acceptances → one success,
  the rest 409 `invitation_used_conflict`. Expired/revoked → 410.
* Acceptance creates/reuses the tenant judge for the account, joins `competition_judges`, sets state `active`
  (re-activates a previously removed judge without verification) and inserts a `role_grants` row
  (`judge`, organization + competition scoped, granted by the inviter).
* Delivery is out of band: no email is sent by this module. The audit log stores a SHA-256 of the email, not the email.

## Lifecycle and verification

`active → verified | suspended | removed`, `verified → suspended | removed`, `suspended → active | removed`;
`removed` is terminal (a new invitation re-activates). Optimistic `expectedRevision` (409 `judge_revision_conflict`).
Suspension/removal revoke the judge role grant (sets `revoked_at`); reactivation grants again and clears
verification. Removal closes all panel assignments. Only `verified` judges may submit scores
(`judge_not_verified`, 403); `active`/`verified` may view assignments.

## Conflicts and recusals

A judge declares a conflict (`POST judging/conflicts {entryId, reason}`) — this recuses them immediately; a
producer may also recuse (`POST judges/recusals {judgeId, entryId, reason}`). Recusals are idempotent per
judge+entry, kept forever, and only a producer can lift one with a reason (`.../recusals/{id}/rescind`).
`assertPerformanceAccess` (used by scoring and critiques) refuses recused entries (403 `judge_recused`) and
reports performances outside the judge's assigned rounds as 404.

## Tested

Domain: bounds, single-use/expiry ordering, full lifecycle table, role/view/score derivation. Integration:
invite→accept→role grant usable via the real `AuthenticationService` (and not for another competition), token
hashing, concurrent acceptance (one winner, one grant), email mismatch, expiry, re-invite revocation, explicit
revocation, lifecycle with revision conflict and grant revocation/re-grant, panel cleanup on removal, assigned-round
visibility, self-declared and producer recusals, rescind, unverified view-only, audit chain, cross-tenant negatives.
Handlers: producer vs judge separation, member acceptance with 403/410/409 mapping, id/body/query validation.

## Not claimed

No invitation email delivery, no identity verification beyond email match and producer verification, no
judge-facing history of past competitions.
