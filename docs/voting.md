# Voting engine (LC-28)

Configurable audience voting for a competition: scheduled vote windows,
eligibility, ballot constraints, weighting, result visibility and idempotent
ballot submission. Feature key: `voting`. Integrity controls (voids, proofs,
recount, anomaly flags) are in [voting-integrity.md](voting-integrity.md).

| Layer | Location |
| --- | --- |
| Pure rules | `packages/domain/src/voting.ts` (+ test) |
| Pure tallies | `packages/domain/src/voting-tally.ts` (+ exhaustive test) |
| Merkle tree | `packages/domain/src/merkle.ts` (+ test) |
| Storage/service | `packages/db/src/voting.ts`, `packages/db/src/vote-snapshots.ts` (+ `voting.test.ts`) |
| Migrations | `0042_voting.sql` (windows, options, ballots), `0043_vote_snapshots.sql` (immutable snapshots) |
| HTTP | `apps/web/src/app/api/organizations/[organizationId]/competitions/[competitionId]/voting/**` |
| Page | `apps/web/src/app/live/[organizationId]/[competitionId]/` (`VotingPanel.tsx`) |

## Vote windows

A window belongs to a competition, optionally to a round, and lists 2–100 options.
Each option references an entry of the competition and optionally one of its
performances (a "performance set"). `opensAt`/`closesAt` are server-enforced: a ballot
is accepted only while `status = published` and `opensAt ≤ now < closesAt`.

States: `draft → published → closed`, `draft|published → cancelled`. `publish`/`cancel`
use `expectedRevision`. `close` is allowed once the window has opened (early close or
after the scheduled close). Closing locks the window row (`FOR UPDATE`); ballots hold
`FOR SHARE`, so no ballot can commit after the close, and the close writes snapshot
version 1 in the same transaction. If the producer disconnects, ballots still stop at
`closesAt` (phase `ended`); results for `hidden_until_close` stay hidden until a manager
closes the window.

## Rules (`validateVoteRules`)

| Rule | Values |
| --- | --- |
| `ballotType` / `tallyMethod` | `single`/`plurality`, `approval`/`approval` (`maxSelections`), `distributed`/`points` (`maxPoints` = N points to distribute), `ranked`/`borda` or `irv` (`maxSelections`) |
| `eligibility` | `any_member`, `entitled` (LC-09 entitlement capability `event.view` for the event, resolved via `EntitlementService`, decision recorded), `joined_before_open` (membership created before `opensAt`) |
| `excludeParticipants` (default true) | accounts with an unrevoked `performer` or `judge` grant for the competition cannot vote |
| `weighting` | `equal`, or `verified` (accounts with a verified `account_identities` row get `verifiedWeight`, 1–10) |
| `resultVisibility` | `hidden_until_close` (default), `live`, `never_public`. Managers (`event.manage`) always see results |
| `allowChange` | when true, a new ballot supersedes the previous one until close; otherwise a second ballot is `409 vote_conflict` |

All voters must be active members, must have accepted the competition's audience terms
(LC-27 consent) and are rate limited (10 ballots/min per account).

## Ballots and idempotency

`POST …/voting/windows/[windowId]/ballots` with `{ "choice": … }` and an
`Idempotency-Key` header (or `idempotencyKey` in the body; 8–128 `[A-Za-z0-9_-]`).
The key is unique per (tenant, window, account). Retrying with the same key and the same
choice returns the original receipt (`200`, `replayed: true`) — even after the window
closed; the same key with a different choice is `409 idempotency_conflict`.

Choices: `{optionId}`, `{optionIds:[…]}`, `{allocations:{optionId: points}}`,
`{ranking:[…]}`; they are validated and canonicalized (sorted where order is irrelevant).

The response carries the pseudonymous `receipt`, the `salt`, the ballot `commitment`
`sha256("lce-ballot-v1\n" + receipt + "\n" + canonicalChoice + "\n" + weight + "\n" + salt)`
and the weight. The voter keeps it to verify inclusion later (LC-29).

## Tallies (`packages/domain/src/voting-tally.ts`)

Pure, integer-only functions: `tallyPlurality`, `tallyApproval`, `tallyPoints`,
`tallyBorda` (n−1−i points per position, unranked 0), `tallyInstantRunoff`, and the
dispatcher `tallyBallots`. Ties are never broken randomly: equal scores share a rank
(1,1,3), rows within a tie follow option order, and every rank-1 option is a winner.
IRV eliminates one option per round — the lowest total, ties broken by the lowest total
in the most recent earlier round where they differ, then by later option order; if all
continuing options are equal they are all winners. Tests cover each method, weights,
exhausted ballots, every tie rule and permutation invariance.

### For results finalization (LC-30)

* Pure: `tallyWindow(method, options, ballots)` in `packages/db/src/voting.ts`
  (wraps `tallyBallots`).
* Service: `finalVoteTally(organizationId, competitionId, windowId)` returns the latest
  immutable snapshot (`source: "snapshot"`, `snapshotVersion`, `merkleRoot`, `tally`,
  `options` with entry/performance ids). It throws `invalid_state_window_not_closed`
  for windows that are not closed.

## Authorization matrix

| Endpoint | Method | Check |
| --- | --- | --- |
| `…/voting/windows` | GET | member (managers also see drafts) |
| `…/voting/windows` | POST | `event.manage` |
| `…/voting/windows/[windowId]` | GET (includes the caller's own active ballot receipt) | member |
| `…/voting/windows/[windowId]` | PATCH `{action: publish|cancel, expectedRevision}` | `event.manage` |
| `…/voting/windows/[windowId]/close` | POST | `event.manage` |
| `…/voting/windows/[windowId]/ballots` | POST | active member (+ eligibility) |
| `…/voting/windows/[windowId]/results` | GET | member, subject to `resultVisibility` |

## Audit

`voting.window_created/published/cancelled/closed`, and `voting.ballot_cast` /
`voting.ballot_changed` with only `{receipt, weight}` — the choice is never written to
the audit log.

## Failure modes

`voter_not_eligible` (403, message carries the reason), `ballot_voided` (403),
`vote_conflict` / `idempotency_conflict` / `revision_conflict` (409),
`invalid_state_window_not_open` (409), `consent_required` / `invalid_ballot` (400),
`rate_limited` (429), `feature_disabled` (403), `vote_window_not_found` (404).

## Tested

Domain vitest (rules, ballots, commitments, phases, eligibility, weighting, visibility,
tallies, Merkle), node:test integration (idempotent replay incl. after close, one ballot
per account under 8 parallel requests, identical retries collapsing, a close racing with
ballots — snapshot count equals stored active ballots, eligibility rules incl. entitlement
and tenure, excluded entrants/judges, feature veto at event scope, vote change with
supersede, verified weighting, IRV tie, cross-tenant denial, drafts hidden, revision
guards), handler vitest.

## Not claimed

* Live tallies are computed on read (O(ballots)); no caching or load evidence.
* "Verified" means an `account_identities` row with `verified_at`; the engine does not
  perform identity verification itself.
* No scheduler closes windows automatically; ballots stop at `closesAt` regardless.
