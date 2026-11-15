# Audience interaction, voting and integrity (LC-27, LC-28, LC-29)

**Gating.** Chat/questions/polls use the `chat` feature family and voting uses `voting` (LC-08 hierarchical flags; platform default off, an explicit `false` at any scope vetoes). Reactions are always bounded to the event's configured set. Every first interaction requires explicit audience consent (`consent: true`, stored per event in `audience_consents`).

**Interaction (LC-27).** Reactions are rate-limited per account (`audience.reactionsPerMinute`); chat/questions are limited to 5 per minute, enter a moderation queue and are public only once approved — author identities are never returned publicly. Polls allow one answer per account.

**Voting (LC-28).** Producers create vote windows for a stage (options default to its running order), a matchup (its two sides) or explicit entries; configure eligibility (`any_account`, `tenant_members`, `entitled` via LC-09 entitlements), votes per voter, optional votes per network, member weighting and result visibility (`live`, `after_close`, `hidden`). Windows move `scheduled → open → closed`; closing records a tally digest. Closed windows for a stage feed LC-20 scoring as the audience share when `scoring.audienceWeight > 0`.

**Integrity (LC-29).** Votes store a per-window keyed voter hash (no account id), a daily-rotating network hash (from `VOTE_NETWORK_SECRET`), a new-account flag, and a SHA-256 hash chain (`prev_hash → row_hash`, unique per window). Votes and voids are append-only. `GET vote-windows/{id}/audit` verifies the chain, recomputes the tally digest and compares it to the digest recorded at close, and reports heuristic anomalies (per-minute bursts, single-network concentration, new-account surges) for human review. Producers can void votes sharing a network fingerprint with a reason; the original votes remain. Concurrent votes by one account are serialised (row lock + unique constraint).

**Bootstrap.** `PLATFORM_OPERATOR_EMAILS` grants `platform_operator` (audited, idempotent) when a listed account signs in, so feature families can be enabled without database access.
