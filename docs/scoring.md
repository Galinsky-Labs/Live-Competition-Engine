# Configurable scoring (LC-20)

Producers define versioned rubrics per competition; verified judges on a round's panel score each
performance per criterion; submitted sheets are immutable and change only through producer-approved
corrections; standings are computed by a pure, exhaustively tested function.

## Layers

| Layer | Location |
| --- | --- |
| Domain | `packages/domain/src/scoring.ts` — `parseRubric`, `validateScoreValues`, `sheetScore`, `aggregate`, `zScores`, **`computeStandings`**, correction rules |
| Schema | `packages/db/migrations/0023_scoring.sql` — `scoring_rubrics`, `score_sheets`, `score_corrections` (+ immutability triggers) |
| Service | `packages/db/src/scoring.ts` |
| HTTP | `.../competitions/{id}/scoring/**`, `.../rounds/{roundId}/performances/{performanceId}/scores` |
| Pages | judge score panel on `/console/{org}/competitions/{id}/judging`; producer `/console/{org}/competitions/{id}/moderation` |

## Rubric definition

```json
{ "criteria": [{ "key": "execution", "label": "Execution", "min": 0, "max": 10, "step": 0.5, "weight": 2 }],
  "aggregation": { "method": "weighted_mean | sum | median | trimmed_mean", "trim": 1 },
  "normalization": "none | z_score",
  "tieBreakers": [{ "type": "criterion", "key": "execution" }, { "type": "judge_count" }, { "type": "head_judge" }] }
```

1–20 criteria, `min < max`, `step > 0` with `max` on the grid and ≤10 000 steps, weight in (0, 100]; `trim` 1–5 only
for `trimmed_mean`; ≤10 distinct tie-breakers. Versions are numbered per competition and immutable once created
(trigger). One active version; activation retires the previous one and is refused once submitted scores exist under
the active version (`invalid_state_scores_exist`).

## Computation (`computeStandings`)

* Sheet score: criterion-weighted mean Σwᵢvᵢ/Σwᵢ; for `sum`, the weighted sum Σwᵢvᵢ.
* Optional z-score normalization per judge over the sheets in scope (population σ; a judge with < 2 sheets or no spread
  contributes 0).
* Performance score: aggregate of its sheet scores — mean (`weighted_mean`), `sum`, `median`, or `trimmed_mean`
  (drops `trim` highest and lowest; with fewer than 2·trim+1 sheets nothing is dropped and `trimApplied` is false).
* Entry score: sum of its performance scores in scope (round or whole competition).
* Ranking: higher score first; equal scores go through tie-breakers in order (higher criterion mean; more sheets; higher
  head-judge score, missing head score loses). Still equal → shared rank (1, 1, 3). Values are quantized to 1e-9 so
  floating-point noise never decides a rank. Output is independent of input order. Unscored entries are listed last
  with rank `null`.

## Score sheets

* `PUT rounds/{roundId}/performances/{performanceId}/scores {values, submit, expectedRevision}` — judge must have
  `judging.score` for the competition, be `verified`, sit on the round's active panel, and not be recused from the entry.
* Drafts may be partial; submission requires every criterion. One current sheet per judge per performance (unique
  index); concurrent first saves → one 409 `score_revision_conflict`.
* Submitted sheets are immutable (DB trigger blocks value edits and deletes); re-submitting identical values is a
  no-op (200, `changed: false`); different values → 409 `score_immutable_conflict`.
* Corrections: the judge requests `POST scoring/corrections {sheetId, values, reason}` (one pending per sheet); a
  producer other than the requester decides `POST scoring/corrections/{id}/decision {decision, reason?, expectedRevision}`
  (reason required to reject). Approval marks the original `superseded` and inserts a new submitted sheet linking to it
  and to the correction. Nothing is deleted. All submissions and correction steps are audited with values.

## Standings API

`GET scoring/standings[?roundId=]` (`event.manage`) returns rubric version, scope and ranked rows (rank, score, raw score,
sheet count, criterion means, head-judge score, tie-break used, tied flag). These are provisional; results
finalization (a later milestone) should call `computeStandings` with the same inputs.

## Tested

Domain: 44 cases (rubric bounds, grid validation, each aggregation method, trimming fallback, z-scores, every tie-breaker,
shared ranks, multi-round sums, float noise, order independence, correction rules). Integration: draft/submit/idempotency,
immutability against direct SQL, rubric immutability and activation lock, panel/recusal/verification enforcement,
concurrent saves, correction request/self-approval/approval/rejection and standings change, audit chain, cross-tenant
negatives. Handlers: judge vs producer separation, error mapping, id/query validation.

## Not claimed

No public results page or result finalization; no per-judge weighting; z-score is computed over the requested scope only.
