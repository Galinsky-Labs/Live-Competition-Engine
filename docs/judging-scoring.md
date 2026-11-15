# Judges, scoring and critiques (LC-19, LC-20, LC-21)

## Judges (LC-19)
Producers invite an existing account by email (`POST judges`); the account joins the tenant but receives **no access** until it accepts (`POST judges/respond`), which issues a competition-scoped `judge` role grant. Removal (`POST judges/{id}/remove`, reason required) revokes the grant. Judges or producers declare conflicts (`POST recusals`); recused judges cannot score or critique that entry and are not expected for it when checking panel completeness. Blind judging (`judging.blind`) hides entrant names in the judge console (`/o/{slug}/events/{id}/judge`).

## Scoring (LC-20)
Criteria come from the event's locked configuration (key, weight, min, max, step). Sheets are validated for presence, range and step; totals are weighted on a 0–100 scale (each criterion scaled to 0–1). Sheets can only be submitted while the stage is live and the performance live/completed, and never after the stage's results are final. `score_sheets` is **immutable** (trigger): a judge corrects a sheet by submitting a superseding sheet with a reason; each sheet can be superseded once and only one original per judge/performance exists (race-safe unique indexes).

Standings (`GET stages/{id}/standings`, producers) use current sheets from accepted judges: aggregation `mean | median | trimmed_mean | sum`, optional per-judge normalization (`judge_zscore`, `judge_minmax`), judge/audience weighting (audience shares come from LC-28 voting), and ordered tie-breaks (`highest_criterion_first`, `audience_vote`, `fewest_low_scores`, `earliest_performance`, `shared_rank`). Ranking is standard competition ranking; results are independent of input order. Rows report whether all expected judges have scored. Stage advancement (LC-15) uses these standings unless the producer supplies an override ranking.

## Critiques (LC-21)
Optional (`critiques.enabled`). One critique per judge and performance, visibility `private` (producers), `contestant` (the entrant's account) or `public` (after producer approval). Every edit/moderation stores the previous version in append-only `critique_revisions`; producer body corrections need a reason. Entrants may appeal a critique on their own entry (one open appeal at a time); upholding an appeal hides the critique with a recorded revision.
