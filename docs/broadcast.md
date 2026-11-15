# Broadcast presentation (LC-26)

Public overlays, scoreboard and on-air text for streams. Migration `0034_broadcast.sql`;
rules `packages/domain/src/broadcast.ts`; service `packages/db/src/broadcast.ts`; HTTP
`apps/web/src/app/api/public/organizations/[organizationId]/competitions/[competitionId]/broadcast/*`
(anonymous) and `.../competitions/[competitionId]/captions/**` (producers); pages under
`/broadcast/{organizationId}/{competitionId}/`.

## Public data (no private data, ever)

Public projections are served only for competitions in a public status
(`published`, `live`, `paused`, `completed`) of the addressed tenant; anything else is a plain
`404 not_found` with no reason.

| Endpoint | Fields |
| --- | --- |
| `GET .../broadcast/overlay` | `competition.title`, `show.state`, `sequence`, `current { displayName, roundLabel }`, `next { displayName }`, `timer { label, status, durationMs, extendedMs, elapsedBeforeMs, runningSince, sequence }`, `lowerThird { text, subtitle }`, `caption { text }`, plus `serverNow`, `timerRemainingMs` |
| `GET .../broadcast/scoreboard` | `competition.title`, `sequence`, `rounds[] { label, ordinal, standings[] { rank, displayName, score, final } }`, `serverNow` |
| `GET .../stream` (LC-22) | published stream playback id only |

Never included: entry/participant/performance/account/timer ids, safety-stop or pause reasons,
backstage content, judge state, unpublished or `void` results. A test serializes the overlay after a
safety stop and asserts none of those values appear.

The scoreboard reads the core `results` table, but only rows whose round has
`round_publications.results_published = true` (set by the LC-25 control room). Unpublishing hides
them again immediately.

## Latency handling

* `sequence` is `show_controls.broadcast_sequence`, incremented in the same transaction as every
  control-room mutation, timer command/creation and caption change. Clients apply a payload only if
  `sequence >= displayed` (`shouldApplyUpdate`), so a slow, out-of-order response never rolls the
  screen back.
* The timer is described by stable values (`runningSince`, `elapsedBeforeMs`, ...) rather than a
  ticking number, so the ETag only changes when something actually happens. Clients compute
  `publicTimerRemaining(timer, serverNowEstimate)` locally.
* `x-server-now` (epoch ms) is sent on 200 **and** 304 responses; the page keeps a clock offset using
  the midpoint of request/response to compensate one-way latency.
* Caching: strong `ETag` + `If-None-Match` → 304; `Cache-Control: public, max-age=1,
  stale-while-revalidate=2` (overlay) or `max-age=5` (scoreboard). CORS `*` (read-only public data).
  Overlay reads use a repeatable-read, read-only transaction for a consistent snapshot.

## On-air text (lower thirds and captions)

Producer-only (`event.manage`): `GET/POST .../captions` `{ kind: "lower_third"|"caption", text,
subtitle? (lower thirds only), idempotencyKey }`, `POST .../captions/{captionId}/clear`.
At most one active item per kind (partial unique index); a new one replaces the old in one
transaction. Every set/clear is audited with the text.

Moderation (`moderateCaption`), rejecting with `400 caption_rejected_<reason>`: ≤120 chars after
whitespace normalization; control/bidi-override characters; markup characters `< > { } \``;
links/domains/e-mail; phone-number-like contact details; tenant blocked terms from
`competitions.rules.broadcast.blockedTerms` (≤200 terms, matched after case/accent/leet folding,
whole-word, or as a substring for terms of 4+ letters). The engine ships no term list: vocabulary is
tenant/product policy.

## Pages (OBS browser sources)

* `/broadcast/{org}/{competition}/overlay` — now performing, timer (overtime in red, "+m:ss"),
  "right back" notice while paused, up-next, lower third and caption.
* `/broadcast/{org}/{competition}/captions` — only lower third and caption.
* `/broadcast/{org}/{competition}/scoreboard` — published standings tables.

Add `?transparent=1` for a transparent background. Animations (slide-in, color transitions) are
disabled under `prefers-reduced-motion: reduce`, and the countdown then updates once per second.
Pages are server-rendered from the same public projection, then poll (1 s overlay, 5 s scoreboard).
No external assets.

## Not implemented

Graphics templating/theming per tenant, SSE/WebSocket push, multi-language captions, live
speech-to-text captions, automatic moderation via an external service.
