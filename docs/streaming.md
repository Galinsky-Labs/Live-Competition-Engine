# Streaming foundation (LC-22)

Provider-backed live streams linked to a competition (`streams` table, migration `0030_streaming.sql`).
Optional capability: every create / re-create / key reset / publish checks feature `streaming`
(`requireEnabledFeature`) before any provider call.

**Real streaming requires Mux credentials** (`MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_WEBHOOK_SECRET`,
validated by `requireMux()` in `packages/config/src/providers.ts`). Without them every provider
operation and the webhook fail closed with `503 provider_not_configured`. The Mux adapter has only
been exercised against a stubbed `fetch`; no live Mux stream was created while building this
milestone, so **no production streaming claim is made**.

## Components

| Layer | File |
| --- | --- |
| Lifecycle (pure) | `packages/domain/src/streaming.ts` (+ vitest) |
| Provider interface + deterministic fake | `packages/db/src/providers/streaming.ts` |
| Mux adapter, signature verification, event parsing | `packages/db/src/providers/mux.ts` |
| Service | `packages/db/src/streams.ts` (+ `streams.test.ts`, `streaming-providers.test.ts`) |
| HTTP | `apps/web/src/app/api/organizations/[organizationId]/competitions/[competitionId]/streams/**`, `apps/web/src/app/api/webhooks/mux`, `apps/web/src/app/api/public/organizations/[organizationId]/competitions/[competitionId]/stream` |

## Lifecycle

```
idle ──► active ──► disconnected ──► active (encoder reconnect)
  │         │             │
  └─────────┴─────────────┴──► ended | failed   (terminal for the row)
```

* Provider events (normalized from Mux `video.*`): `live_stream.active` → active,
  `live_stream.disconnected` → disconnected, `live_stream.idle` after a session → ended,
  `live_stream.deleted` → failed (`provider_deleted`), `live_stream.errored` → failed (`provider_error`),
  `asset.*` with `live_stream_id` → recording asset id stored. Illegal or repeated transitions are
  recorded as `ignored:*` instead of failing the webhook (out-of-order delivery).
* Recovery: **reset key** (idle/disconnected; new key shown once), **re-create** (from
  disconnected/ended/failed; a new row with `previous_stream_id`, the old non-terminal row becomes
  `failed: replaced_by_recreate` and the old provider session is completed best-effort), **end**
  (calls the provider's complete endpoint, then `ended`).
* At most one non-terminal stream per competition (partial unique index). Concurrent creates: one wins;
  provider streams created by losers are deleted best-effort.

## Secrets

The stream key is returned **only** in the response that created or rotated it
(`streamKey`, with a notice). The database stores `sha256` of the key and its last 4 characters.
Idempotent replays (`idempotencyKey` reused) return the stored stream **without** the key.
Responses are `private, no-store`.

## API (all `event.manage` scoped to the competition)

| Method | Path | Body |
| --- | --- | --- |
| GET | `.../competitions/{competitionId}/streams` | – |
| POST | `.../competitions/{competitionId}/streams` | `{ idempotencyKey }` |
| GET | `.../streams/{streamId}` | – |
| POST | `.../streams/{streamId}` | `{ action: "recreate", idempotencyKey }`, `{ action: "reset_key" }`, `{ action: "end" }`, `{ action: "publish" \| "unpublish", expectedRevision }` |
| POST | `/api/webhooks/mux` | Mux webhook; requires valid `mux-signature` |
| GET | `/api/public/organizations/{org}/competitions/{competitionId}/stream` | anonymous |

Errors: `stream_not_found` 404, `invalid_state_stream_*` / `stream_conflict_open_stream_exists` /
`stream_revision_conflict` / `idempotency_conflict` 409, `feature_disabled` 403,
`provider_not_configured` 503, `provider_unavailable` & other provider failures 502.

## Webhook

`mux-signature: t=<unix>,v1=<hex>`; HMAC-SHA256 over `${t}.${rawBody}` with `MUX_WEBHOOK_SECRET`,
constant-time compare, 300 s tolerance, verified **before** JSON parsing; body capped at 64 KiB.
Events are inserted into `stream_provider_events` with `UNIQUE (provider, provider_event_id)`, so
redelivery returns `{ outcome: "duplicate" }` with no state change. Every applied transition is
audited (`stream.active`, `stream.failed`, ...) with a null actor.

## Public embed

Only when the competition status is public (`published`/`live`/`paused`/`completed`), feature
`streaming` is enabled, and a producer published the stream: `{ stream: { status, playbackId, live } }`.
Never includes ingest URL, provider stream id, key data or failure reasons. The playback id is a Mux
*public* playback id (`https://stream.mux.com/{playbackId}.m3u8`); signed playback is not implemented.

## Not implemented / remaining

* Signed playback policies, simulcast targets, low-latency mode, DVR configuration.
* Verifying against a real Mux account (needs credentials and a test encoder).
* Mapping of every Mux event type; unknown types are stored as `ignored:no_effect`.
