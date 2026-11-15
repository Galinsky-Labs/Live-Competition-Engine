# Producer control room (LC-25)

Operate the run-of-show: lineup, round/performance transitions, now/next, safety stop, judge
state and results publication. Migration `0033_control_room.sql`; state machines
`packages/domain/src/control-room.ts`; service `packages/db/src/control-room.ts`; HTTP
`.../competitions/[competitionId]/control-room/**`; page `/control/{organizationId}/{competitionId}`.

## Authorization

Every endpoint requires `event.manage` for the competition (event producers scoped to it, or tenant
operators). Identity comes from the session; body fields such as `actorAccountId` are ignored.
Every mutation is audited in the same transaction.

## Concurrency

`show_controls` has one row per competition. Every mutation locks it (`SELECT ... FOR UPDATE`),
so lineup and show changes are serialized per competition, then increments `revision` (clients may
send `expectedRevision` → `409 show_revision_conflict`) and `broadcast_sequence` (used by LC-26
overlays). Lock order is always `show_controls → stage_timers`; timer commands take the show lock
first too, so the safety stop and concurrent timer commands cannot deadlock (tested).

## State machines

| Entity | Allowed transitions |
| --- | --- |
| Show | standby→running, running→paused (safety stop), paused→running (resume), any non-ended→ended |
| Round | scheduled→live\|cancelled, live→completed\|cancelled |
| Performance | queued→live\|skipped, live→completed\|skipped |

Guards: a performance goes live only while the show is `running`, its round is `live` and no other
performance is live; only one round is live at a time; a round completes only when nothing is
queued/live; a cancelled round cannot have a live performance; nothing starts after `ended`.
Completing or skipping is allowed while paused so a safety stop never traps the lineup.

**Now/next**: now = the live performance; next = the first queued performance by (round ordinal,
performance ordinal) among scheduled/live rounds. `show_controls.current_performance_id` mirrors now.

**Lineup**: `POST rounds` (ordinal = max+1, ≤100), `POST rounds/{roundId}/performances` (approved
entries of this competition only), `PUT rounds/{roundId}/lineup { performanceIds }` — a full
permutation; performances that already left the queue must keep their position.

## Safety stop

`POST control-room/safety-stop { reason }` (1–200 chars, single line): in one transaction the show
becomes `paused` with the reason and every running timer of the competition receives a `pause`
command (`reason: "safety_stop: ..."`). Audit `show.safety_stop` lists the halted timers. Resume is
explicit (`POST control-room/show { command: "resume" }`) and does **not** restart timers; any
producer can resume (disconnected-producer case tested).

## Judge state

`JudgeStatusSource.forPerformance(org, competition, performanceId)` is pluggable. The default
`unknownJudgeStatusSource` lists the competition's judges with `submitted: null` and
`status: "unknown"` because scoring is built by another module; the control room must never treat
unknown as submitted. A scoring module should provide a source reading its own score table and be
wired in `control-room/wiring.ts`.

## Results publication

`POST control-room/rounds/{roundId}/publication { published, expectedRevision? }` stores
`round_publications.results_published` (revision-guarded, audited `results.published` /
`results.unpublished`). LC-26 public scoreboards show results only for published rounds.

## API summary

| Method | Path |
| --- | --- |
| GET | `control-room` (show, rounds with entry ids, now/next, judge status, approved entries) |
| POST | `control-room/show` `{ command: "start"\|"resume"\|"end", expectedRevision? }` |
| POST | `control-room/safety-stop` `{ reason }` |
| POST | `control-room/rounds` `{ label }` |
| POST | `control-room/rounds/{roundId}/status` `{ status, expectedRevision? }` |
| PUT | `control-room/rounds/{roundId}/lineup` `{ performanceIds, expectedRevision? }` |
| POST | `control-room/rounds/{roundId}/performances` `{ entryId }` |
| POST | `control-room/rounds/{roundId}/publication` `{ published, expectedRevision? }` |
| POST | `control-room/performances/{performanceId}/status` `{ status, expectedRevision? }` |

## Page

`/control/{organizationId}/{competitionId}` renders a server shell with no data; a client component
asks for a session token (kept in `sessionStorage` of that tab only), polls the APIs every 2 s and
offers show controls, safety stop, lineup with move up/down, round/performance transitions,
publication toggles, judge state, timers and on-air text. Semantic headings, labelled inputs,
`role="status"` live region, keyboard-operable buttons with visible focus.

## Not implemented

Competition `status` column is not changed by the control room (the show state is separate);
judge submission data awaits a scoring source; no drag-and-drop reordering.
