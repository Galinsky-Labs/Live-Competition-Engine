# Audience interaction (LC-27)

Optional, bounded audience participation for a competition ("event"): reactions,
chat, audience questions and polls. Every capability is independently gated by an
LC-08 feature flag and every write requires explicit consent to the event's
audience terms.

| Layer | Location |
| --- | --- |
| Pure rules | `packages/domain/src/audience.ts` (+ `audience.test.ts`) |
| Rate limiter | `packages/db/src/rate-limit.ts` (+ test), migration `0040_rate_limits.sql` |
| Storage/service | `packages/db/src/audience.ts` (+ `audience.test.ts`), migration `0041_audience_interaction.sql` |
| HTTP | `apps/web/src/app/api/organizations/[organizationId]/competitions/[competitionId]/audience/**`, blocked terms under `apps/web/src/app/api/organizations/[organizationId]/audience/blocked-terms/**` |
| Page | `apps/web/src/app/live/[organizationId]/[competitionId]/` |

## Feature flags

| Capability | Feature key | Checked with |
| --- | --- | --- |
| Reactions | `reactions` | `requireEnabledFeature(feature, { organizationId, eventId, accountId })` before any write |
| Chat (post, moderate, mute) | `chat` | same; moderation checks without `accountId` |
| Questions | `questions` | same |
| Polls | `polls` | same |

A disabled feature returns `403 feature_disabled`. Reads of existing data are not
feature-gated (so moderators can still inspect history after turning a feature off).

## Consent

`audience_settings` (one row per competition) stores the current `terms_version`.
Participating (react, chat, ask, upvote, poll vote; and voting in LC-28) requires an
`audience_consents` row for the **current** version. Changing the terms version
requires every participant to accept again. Without settings, participation fails
closed with `audience_settings_not_found`. Consent rows reference the active
organization membership.

## Rate limiting (`packages/db/src/rate-limit.ts`)

`consumeRateLimit(sql, { organizationId, accountId, action }, { limit, windowMs, mode })`
keeps one counter row per tenant + account + action + window. The increment is a single
conditional `INSERT … ON CONFLICT DO UPDATE … WHERE count < allowance`, so concurrent
callers can never exceed the limit (tested with 20 parallel calls). `sliding` mode weights
the previous window's count by the fraction still inside the sliding window. Rejections
throw `DomainError("rate_limited")` (HTTP 429) and are not counted. Called inside the
caller's transaction, a hit rolls back with the work. `pruneRateLimitCounters(before)`
removes old windows (run it from a scheduled job; no scheduler is shipped here).

Defaults (`audienceRateLimits`): reactions 30/10 s sliding, chat 5/10 s sliding,
questions 3/min, upvotes 30/min, poll votes 10/min.

## Capabilities

* **Reactions** — fixed neutral set `applause, heart, star, wow, laugh`. Counts are
  aggregated per performance in `audience_reaction_counts` (no per-click rows), so storage
  is bounded by performances × kinds.
* **Chat** — body 1..`chat_max_length` (≤1000) characters without control characters;
  per-account rate limit; per-competition slow mode (`slow_mode_seconds`, enforced under a
  per-account advisory lock so it cannot be raced); tenant blocked-term list (whole-token
  match after NFKD/diacritic/case/punctuation normalization; substrings inside other words
  do not match); mutes per competition with an expiry (≤30 days) and revocation.
  Moderation (`hide`, `unhide`, `delete`) is an explicit state machine
  (`visible → hidden ↔ visible`, `* → deleted`, deleted is terminal) and **deletion clears
  the body**. Members see only visible messages; managers see all with reasons.
* **Questions** — 3..300 characters, rate limited, blocked terms and mutes apply. One
  upvote per account (primary key + row lock; concurrent duplicates count once). Producers
  mark `answered` or `dismissed`; both are terminal.
* **Polls** — producers create 2–10 unique options, `draft → open → closed`, optional
  server-enforced `closesAt` (votes after it are rejected even if the producer never closes
  the poll). One vote per account (primary key; duplicates → `409 vote_conflict`). Result
  visibility: `live` (once open), `after_close`, or `never` (managers only). Revisions
  guard open/close.

## Authorization matrix

| Endpoint | Method | Check |
| --- | --- | --- |
| `…/audience/settings` | GET | active member |
| `…/audience/settings` | PUT | `event.manage` (body `expectedRevision`, 0 to create) |
| `…/audience/consent` | POST | active member |
| `…/audience/reactions` | GET (`?performanceId=`) / POST | active member |
| `…/audience/chat` | GET (managers also see moderated) / POST | active member |
| `…/audience/chat/[messageId]` | PATCH `{action, reason}` | `event.manage` |
| `…/audience/mutes` | POST `{accountId, durationSeconds, reason}` | `event.manage` |
| `…/audience/mutes/[muteId]` | DELETE | `event.manage` |
| `…/audience/questions` | GET / POST | active member |
| `…/audience/questions/[questionId]` | PATCH `{status}` | `event.manage` |
| `…/audience/questions/[questionId]/upvote` | POST | active member |
| `…/audience/polls` | GET / POST | member / `event.manage` |
| `…/audience/polls/[pollId]` | GET / PATCH `{action, expectedRevision}` | member / `event.manage` |
| `…/audience/polls/[pollId]/votes` | POST `{optionId}` | active member |
| `/api/organizations/[organizationId]/audience/blocked-terms` | GET / POST | `tenant.manage` |
| `…/blocked-terms/[termId]` | DELETE | `tenant.manage` |

Identity always comes from the bearer session, never from the body.

## Audit

`audience.settings_updated`, `audience.chat_moderated`, `audience.account_muted`,
`audience.mute_revoked`, `audience.blocked_term_added/removed` (term text is not copied
into the log), `audience.question_decided`, `audience.poll_created/opened/closed` are
recorded in the same transaction. Individual reactions, chat posts and poll votes are not
audited (high volume, low stakes); ballots in LC-28 are.

## Failure modes

`competition_not_found`/`message_not_found`/… → 404; `forbidden`/`feature_disabled` → 403;
`rate_limited` (rate limit or slow mode) → 429; `revision_conflict`, `vote_conflict`,
`invalid_state_*` → 409; `consent_required`, `terms_version_mismatch`, `account_muted`,
`message_blocked`, validation codes → 400.

## Tested

Domain vitest (validation, normalization, state machines, visibility), node:test
integration (settings revisions, consent/version change, feature vetoes, reaction
aggregation and rate limit under 40 parallel requests, slow mode, blocked terms, mutes,
moderation audit and chain verification, cross-tenant read/moderation/participation
denial, concurrent upvotes and poll votes, scheduled poll close), handler vitest (401/403,
validation, error mapping, identity from session).

## Not claimed

* No realtime transport (WebSocket/SSE): clients poll. No production load evidence.
* The blocked-term matcher is a simple normalized token match, not a moderation model;
  deliberate obfuscation (e.g. inserted letters) is not detected.
* The participation page is a minimal reference client; products build their own UI.
