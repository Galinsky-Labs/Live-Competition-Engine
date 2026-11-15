# LC-16 Head-to-head and bracket model (optional)

Brackets are **optional**: gated by the LC-08 `brackets` feature (event-scoped evaluation, checked
before any side effect and on reads), and no other table or module requires them. Events, stages and
results work unchanged with the feature off.

## Model (`0017_brackets.sql`)

* `teams` / `team_members`: generic groups (crews, ensembles, duos) per event; a participant belongs
  to at most one team per event; names unique per event (case-insensitive). Not feature-gated.
* `matches`: between **2..64 sides** (`expected_sides`). Standalone matches have no bracket; bracket
  matches carry `round_number`, `position`, `next_match_id` + `next_slot`. `revision` for If-Match.
* `match_sides`: `(match_id, slot)` → exactly one of `entry_id` (composite FK guarantees the entry is
  in the same event) or `team_id`, plus `seed`. A side may appear once per match.
* `brackets`: `single_elimination`, `side_kind` entry|team, `size` (power of two, ≤ 256), optional
  `stage_id` (one bracket per stage), `idempotency_key` (unique per tenant), status active|completed.

## Pure logic (`packages/domain/src/brackets.ts`)

* `seedOrder(size)` gives the standard order (8 → 1,8,4,5,2,7,3,6) so seed 1 meets seed N in round one
  and seeds 1 and 2 can only meet in the final.
* `generateSingleElimination(sides)` requires seeds exactly 1..N; size = next power of two; missing
  seeds are **byes** that fall to the top seeds. Bye matches are emitted already decided and the seed is
  placed in its round-2 slot. Deterministic (input order does not matter).
* Match lifecycle: `scheduled → live → decided`, `scheduled|live → void` (reason required). Start
  requires all sides present; decide requires a winner slot among the sides.

## Services (`packages/db/src/brackets.ts`)

* `actOnMatch` locks the match (`FOR UPDATE`), checks the revision, applies the transition, and on
  `decide` inserts the winner into `next_match_id`/`next_slot` (the next match must still be
  scheduled); deciding the final marks the bracket `completed`. Audited: `match.started|decided|voided`,
  plus `bracket.created`, `match.created`, `team.created`.
* Voiding a bracket match does not advance anyone; the dependent match cannot start (operators can
  create a new bracket). This is deliberate: no implicit winners.
* `bracketWinnersForStage` plugs into LC-15: a stage with a `bracket` advancement contract advances the
  champion of its completed bracket (entry id, or team id for team brackets).

## HTTP (event.manage with `competitionId`)

* `GET|POST /api/organizations/{org}/competitions/{competitionId}/teams`
* `GET|POST .../brackets` (`POST {sides:[{entryId|teamId, seed}], stageId?, idempotencyKey}`; replay → 200)
* `GET .../brackets/{bracketId}` (full read with side display names)
* `POST .../matches` (`{sides:[{entryId|teamId}]}`, standalone 2..64 sides)
* `POST .../matches/{matchId}/transitions` (`{action: start|decide|void, winnerSlot?, reason?}` + `If-Match`)
* `GET /api/public/organizations/{org}/competitions/{competitionId}/brackets/{bracketId}` — anonymous,
  only for `public`, non-draft events with the feature on.

## Tested

Domain: seed order, full/odd/minimal brackets, byes, determinism, invalid seeds, lifecycle matrix.
Integration: 3-entrant bracket with a bye through to completion and LC-15 advancement, revision/void
rules, a 4-way concurrent winner race (one succeeds, one advancement), teams + 3-sided match + team
bracket, cross-tenant denial, foreign entries refused, public visibility, feature-off failures while
stages keep working.

## Not implemented

Double elimination, round robin/Swiss, scheduling of match times, re-seeding after voids.
