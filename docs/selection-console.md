# Producer selection console (LC-18)

Producers (`event.manage` for the competition — event producers or tenant operators) review submitted
applications, record decisions (individually or in bulk), build each round's running order from selected
entries, and assign judges to round panels.

## Layers

| Layer | Location |
| --- | --- |
| Domain | `packages/domain/src/selection.ts` — lineup validation and minimal-change planning, panel roles |
| Schema | `packages/db/migrations/0021_selection.sql` — `round_lineups` (revision), `round_lineup_history` (append-only), `round_judge_panels`, `competition_judge_states`, `judges.account_id`, `performances (organization_id, id)` unique |
| Service | `packages/db/src/selection.ts`; decisions reuse `decideApplications` from `applications.ts` (LC-17) |
| HTTP | `.../competitions/{competitionId}/selection`, `.../rounds/{roundId}/lineup[/history]`, `.../rounds/{roundId}/panel` |
| Page | `/console/{organizationId}/competitions/{competitionId}/selection` |

## Decisions

Decisions use the LC-17 status machine and history. Each decision carries the application's
`expectedRevision`; the form row lock serializes decisions per competition, so when two producers decide the
same application concurrently exactly one succeeds and the other receives 409 `application_revision_conflict`
(the console then reloads and explains). Bulk decisions (≤100) are atomic. History rows record who, when,
previous status, new status and reason, and are append-only (database trigger); each decision is also in the
hash-chained audit log. Waitlist promotion on withdrawal of a selected entrant is automatic (`system` actor,
reason `waitlist_promotion`).

Reviewer safety: the review projection excludes drafts and shows contact email only with the applicant's
contact-sharing consent (see `docs/applications.md`).

## Running order (slot assignment)

`PUT rounds/{roundId}/lineup {entryIds[], expectedRevision, reason?}` replaces the order. The service plans the
minimal change (moved slots keep their `performances` row so later scores stay attached), refuses entries that
are not `approved` in this competition (`entry_not_eligible`), refuses moving/removing performances that have
started (`invalid_state_performance_started`) or deleting slots that carry scores/critiques
(`invalid_state_slot_has_records`), and refuses closed rounds. Revisions are optimistic: two producers saving
the same revision → one 409 `lineup_revision_conflict`. Every save appends a `round_lineup_history` version.

## Judge panels

`POST rounds/{roundId}/panel {judgeId, role: panelist|head}` assigns a competition judge (must be in
`competition_judges` for this competition and not suspended/removed). Idempotent for the same role; a role
change closes the old assignment and opens a new one (history kept via `removed_at`). One active head judge per
round (409 `panel_head_conflict`). `DELETE rounds/{roundId}/panel?judgeId=` removes. All changes are audited.

## Console page

Server-rendered shell (no data rendered server-side) plus a client component that calls the APIs with a bearer
token supplied by the host page through `window.lceConsoleAuthorization` (see `apps/web/src/lib/console-client.ts`).
Semantic headings, labelled controls, table with caption/row headers, a polite live region for results and
conflicts, keyboard-operable reorder buttons (no drag and drop).

## Tested

Domain planning (create/reorder/remove/no-op/started/duplicates/bounds). Integration: versioned lineup with history,
concurrent producers (one conflict), eligibility, started/closed locks, panels (idempotent, head conflict, role
change, removal, suspended judge), audit, cross-tenant negatives. Handlers: authorized, 403, 404, 400, 409 mapping.
Console client: bearer header, fail-closed without token, conflict messaging.

## Not claimed

No sign-in flow inside the console (the host must supply the token). No drag-and-drop ordering. No automatic
schedule times for slots.
