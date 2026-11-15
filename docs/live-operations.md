# Timer, control room and broadcast (LC-24, LC-25, LC-26)

## Server-authoritative timer (LC-24)
Clocks are append-only command logs (`timer_events`, trigger-enforced) keyed per performance (`performance:{id}`) or stage. Commands: `start`, `pause`, `resume`, `extend` (bounded by `timing.maxExtensionSeconds`), `reset`, `stop`. Timestamps come from the database clock (`clock_timestamp()`), never the client. State is a pure replay of the log (`engine/timer.ts`), so every viewer and any reconnecting producer derive the same remaining/overtime/grace values. Producers may send `expectedSeq`; concurrent commands on the same sequence get `409 timer_sequence_conflict`.

## Control room (LC-25)
The producer console shows the live snapshot, the running order with Start / Complete / Skip (reason) actions, clock controls, on-air text (caption, overlay message), and a **safety stop** that pauses the event and every running clock, posts a `SAFETY STOP` cue to everyone backstage and shows a stand-by notice publicly. At most one performance per stage can be live (partial unique index + check); starting a performance on a timed stage starts its clock in the same transaction and marks the entrant `on_stage`. A disconnected producer loses nothing: all state is server-side and `GET live` restores it.

## Broadcast presentation (LC-26)
`GET /api/organizations/{org}/events/{id}/live` (public for non-draft events, `no-store`) returns one snapshot: event, live stage, current performance and its timer, next up, caption and overlay state, plus `serverNow`. `/o/{slug}/events/{id}/broadcast` is a browser-source page for streaming software; it polls every 2 s, estimates the client↔server clock offset from each round-trip (latency handling) and ticks locally between polls, shows a "reconnecting" notice when polls fail, and announces captions via `aria-live`. Blind-judged events show performance numbers instead of names. Scoreboards are added with results (LC-30).
