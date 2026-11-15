# Streaming and backstage (LC-22, LC-23)

## Streaming provider interface
`@live-competition-engine/engine/streaming` defines `StreamingProvider` with three implementations, selected by `STREAMING_PROVIDER`:

| mode | needs | behaviour |
| --- | --- | --- |
| `disabled` (default) | nothing | stream setup returns `409 streaming_disabled`; no player is shown |
| `external_embed` | nothing | producer supplies an https player URL from an allow-listed host (YouTube, Twitch, Vimeo, Bunny, Cloudflare Stream; extend with `STREAM_EMBED_ALLOWED_HOSTS`) |
| `mux` | `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` | creates a Mux live stream (ingest URL + one-time stream key + playback/embed URL). Without keys it degrades to `disabled`. |

Lifecycle `idle → live → ended`, with `failed` (reason required) and recovery back to `idle`/`live`; every change is revision-checked and audited. The public page shows the player while idle/live, an "interrupted" notice while failed, and the recording once ended. **No stream is claimed live without the producer (or, later, a provider webhook) reporting it** — the Mux adapter is unit-tested against mocked responses only; no real provider stream has been exercised.

## Backstage / green room
`/o/{slug}/events/{id}/backstage` is available to producers (`event.manage`), accepted judges and approved entrants (by `participants.account_id`) only. Audiences are least-privilege: judges read `judges` + `everyone_backstage` and write only to `judges`; performers read `performers` + `everyone_backstage` and write only to `crew` (producers); only producers send cues. Readiness (`ready`, `not_ready`, `technical_issue`, `on_stage`) is set by the performer for their own entry or by producers; judges cannot see readiness.
