# LC-15 Generic stage builder

## Design choice: stages extend rounds (1:1)

A **stage** is the configuration of exactly one `rounds` row (`stages.round_id UNIQUE`, composite
FKs on `(organization_id, round_id)` and `(competition_id, round_id)`). Rounds keep `label`,
`ordinal` (the stage order) and `status`; `results.round_id` keeps working unchanged, so stage
standings come straight from results. Stages add `kind` (audition / qualifier / heat / semifinal /
final / custom + `custom_label`), `timed` + `duration_seconds`, an `advancement` contract and a
`revision`. Rounds created without a stage (by other modules) are left alone.

## Advancement contracts (`packages/domain/src/advancement.ts`, `stages.ts`)

| type | fields | semantics |
| --- | --- | --- |
| `top_n` | `count`, `ties`: include / exclude / seed | the best `count`; a tie group straddling the cut is fully included, fully excluded, or broken by seed then entry id |
| `score_threshold` | `minScore`, `inclusive` | entries whose score passes; unscored never pass |
| `manual` | `maxSelections?` | the producer's `selection` (subset of standings) |
| `bracket` | — | winners resolved by the optional LC-16 bracket module |

`computeAdvancement(contract, standings, selection?)` is pure and deterministic: standings are
totally ordered by rank asc, score desc (nulls last), seed asc, entry id; a *tie* is equal
(rank, score). It returns `advancing`, `eliminated`, `tiedAtCut`, `tieBroken`, independent of
input order. Template phases (LC-14) validate their `advancement` with the same schema.

## Decisions

`POST .../stages/{stageId}/advancement {idempotencyKey, selection?}` locks the stage, loads the
best **final** result per **approved** entry of the stage's round, computes the outcome and stores
one append-only `stage_advancements` row (input standings, contract snapshot, outcome; UPDATE is
blocked by trigger; `UNIQUE(stage_id)`). A retry with the same key returns the stored decision
(200, `replayed: true`); any other second attempt is `stage_advancement_conflict` (409).
Audit: `stage.created`, `stage.updated`, `stage.reordered`, `stage.advancement_decided`.
A decided stage can no longer be edited.

## Ordering

`PUT .../stages/order {stageIds}` must be a permutation of all stages. Stages are permuted within
their existing ordinal slots (two-phase update avoids unique-index clashes); a stage whose round is
no longer `scheduled` cannot move. Event row lock serializes builder writes.

## HTTP (all `event.manage` with `competitionId`)

* `GET|POST /api/organizations/{org}/competitions/{competitionId}/stages`
* `PUT .../stages/order`
* `PATCH .../stages/{stageId}` (`If-Match` required)
* `GET|POST .../stages/{stageId}/advancement` (`Idempotency-Key` header or body field)

Errors: `invalid_stage_*`, `invalid_advancement_*` 400; `stage_revision_conflict`,
`stage_advancement_conflict`, `invalid_state_*` 409; `stage_not_found`, `event_not_found` 404.

## Tested

Domain: tie policies, determinism under shuffles, thresholds, manual/bracket selections, input
validation, permutations. Integration: ordering/reorder (incl. started-round guard), revisions,
decision from final results with tie inclusion, idempotent replay, append-only trigger, a 5-way race
(one decision), bracket resolver hook, cross-tenant denial, closed events.

## Not implemented

Automatic entry of advancing entries into the next stage's performances (left to scheduling
milestones), reversal of a decision (by design; corrections are a new stage).
