# Server-authoritative timer (LC-24)

Trusted stage time per performance (or per competition stage when `performanceId` is null).
Migration `0032_stage_timers.sql`; reducer `packages/domain/src/timer.ts`; service
`packages/db/src/timers.ts`; HTTP `.../competitions/[competitionId]/timers/**`.

## Model

* `stage_timers` holds configuration (label, initial `durationMs`, `maxExtensionMs`) and a
  `head_sequence` cache. It holds **no clock state**.
* `stage_timer_commands` is an append-only log (trigger blocks UPDATE/DELETE) of
  `start | pause | resume | extend | reset` with a per-timer `sequence` (primary key with the timer id)
  and the **server** time `issued_at_ms`.
* State = `replayTimer(config, log)` — a pure reducer; the same log always yields the same state.
  Command timestamps are clamped to be monotonic, so clock skew between app servers can never make
  time run backwards.

```
idle --start--> running --pause--> paused --resume--> running
any --reset(durationMs?)--> idle         extend(amountMs): idle | running | paused
```

`phase` adds the derived `overtime` (running with `remainingMs <= 0`). Overtime keeps counting
(`remainingMs` negative, `overtimeMs` positive); the producer decides what to do.

Limits: duration 1 s–6 h, extension step 1 s–10 min, total extension ≤ `maxExtensionMs` (≤ 1 h),
1,000 commands per timer, reason ≤ 200 chars.

## Concurrency and disconnected producers

* Every command locks the timer row (`SELECT ... FOR UPDATE`), replays the log, validates and appends
  `sequence + 1`. Concurrent producers are serialized; illegal commands fail with
  `409 invalid_state_timer_<status>_<command>` (e.g. eight simultaneous pauses → one wins).
* Optional `expectedSequence` gives clients optimistic concurrency (`409 timer_sequence_conflict`).
* `idempotencyKey` per timer: a retried request returns the current view with `replayed: true` and
  appends nothing.
* Timers run on the server: when the producer's browser disconnects nothing changes; any other
  account with `event.manage` for the competition can pause/resume/extend/reset. Each command records
  its actor and is audited (`timer.start`, ...).

## Client sync

Responses carry `{ status, phase, remainingMs, elapsedMs, overtimeMs, sequence, serverNow, serverNowIso }`.
Clients store `receivedAt` and render `remainingMs - (Date.now() - receivedAt)` while running. They
drop any response whose `sequence` is lower than one already applied.

## API

| Method | Path | Who |
| --- | --- | --- |
| GET/POST | `.../timers` | GET any live role; POST `{ performanceId?, label, durationMs, maxExtensionMs? }` producer |
| GET | `.../timers/{timerId}` | any live role (producer, judge, performer) |
| POST | `.../timers/{timerId}/commands` | producer: `{ type, amountMs?, durationMs?, reason?, idempotencyKey, expectedSequence? }` |
| GET | `.../timers/{timerId}/commands` | producer: full log |

## Tests

Reducer: transition matrix, overtime, determinism, bounds, monotonic clamping, "no producer
connected" progression. PostgreSQL: takeover by a second producer with a controllable server clock,
idempotent retry, eight concurrent pauses (one wins), six concurrent extends (gap-free sequences,
monotonic timestamps), append-only enforcement, cross-tenant rejection.
