# Stages, entrants and brackets (LC-15, LC-16)

**Entrants** are `entries` (approved) for an event, backed by a `participants` row that is an individual or a group (`participant_group_members`). Group formats enforce the configured group size; `maxEntrants` caps approved entries.

**Stages** are `rounds` with `kind` (audition, qualifier, heat, round, semifinal, final, showcase, custom), `format` (`lineup`, `head_to_head`, `round_robin`, `group`), optional timing (`timed` + `durationSeconds`) and an **advancement contract**:

| rule | meaning |
| --- | --- |
| `none` | nobody advances automatically |
| `top_n` (`count`, `tiesAdvance`) | best N by rank; ties at the cut advance by default |
| `threshold` (`minScore`) | everyone at or above the score |
| `manual` | producer selection (must be stage entrants) |
| `bracket_winners` | the bracket champion (head-to-head only) |

Stage lifecycle `scheduled → live → completed` (or `cancelled`); only one stage is live at a time and only while the event is live. Advancement runs from a completed stage into a later scheduled stage, seeds by rank, and marks source entrants `advanced`/`eliminated`. Standings come from LC-20 scoring, or a producer ranking override.

**Brackets** are optional. Single elimination uses standard seeding (1 v N, byes to top seeds) and links each matchup to the next (`next_matchup_id`, `next_side`); round robin uses the circle method. Decisions are revision-checked, only allowed while the stage is live, propagate winners, eliminate losers and are audited. Corrections need a reason and are refused once the downstream matchup is decided. Database constraints keep every matchup entrant inside the same event and tenant, and the winner one of the two sides.

API (under `/api/organizations/{org}/events/{event}`): `GET|POST entrants`, `POST entrants/{entry}/status`, `GET|POST stages`, `PATCH stages/{id}`, `POST stages/{id}/start|complete|cancel`, `GET|PUT stages/{id}/entrants`, `POST stages/{id}/advance`, `GET stages/{id}/matchups`, `POST stages/{id}/bracket`, `POST matchups/{id}/decide`. Reads are public for non-draft events; writes need `event.manage`.
