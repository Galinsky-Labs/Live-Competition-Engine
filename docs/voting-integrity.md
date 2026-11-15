# Voting integrity (LC-29)

Abuse controls, anomaly detection, voter privacy and verifiable counts for the
LC-28 voting engine ([voting.md](voting.md)).

| Layer | Location |
| --- | --- |
| Pure detectors | `packages/domain/src/vote-anomalies.ts` (+ test) |
| Merkle tree | `packages/domain/src/merkle.ts` (+ test) |
| Services | `packages/db/src/voting-integrity.ts`, `vote-snapshots.ts`, `vote-anomaly-store.ts` (+ `voting-integrity.test.ts`) |
| Migrations | `0043_vote_snapshots.sql`, `0044_voting_integrity.sql` |
| HTTP | `…/competitions/[competitionId]/voting/windows/[windowId]/{proof,recount,voids,snapshots,anomalies}` (`integrity-handler.ts`) |

## Abuse controls

* Rate limit: 10 ballots / minute per tenant + account (`voting.ballot`, fixed window).
* Velocity check: 60 ballots / hour per tenant + account (`voting.ballot_velocity`,
  sliding window). Both use the shared `consumeRateLimit` and return `429 rate_limited`.
* One active ballot per account per window (partial unique index + per-voter advisory
  lock), idempotency keys for retries, eligibility and consent checks (LC-28).
* A voided voter cannot vote again in that window (`403 ballot_voided`).

## Anomaly detection (flags only)

Pure functions, deterministic for any input order:

| Detector | Signal | Default |
| --- | --- | --- |
| `detectBursts` | ballots per time bucket far above the median non-empty bucket | 10 s buckets, ≥20 ballots and >5× median |
| `newAccountRatio` | share of ballots from accounts created < 24 h before the window opened (or later) | flagged above 50 % with ≥20 ballots |
| `identicalTimingClusters` | chains of ≥5 ballots each within 50 ms of the previous | — |

Detectors run over every submission (active, superseded and voided) automatically when a
window closes and on demand (`POST …/anomalies`). Flags are stored in
`vote_anomaly_flags` (unique per window + kind + fingerprint, so re-scans are idempotent)
and are reviewed (`reviewed` / `dismissed` with a note). **Nothing is auto-deleted or
auto-voided**; a manager decides and voids explicitly.

## Voter privacy

A ballot row stores the account id (needed for one-per-account rules), the canonical
choice, weight, a random 128-bit pseudonymous `receipt`, a random salt and the commitment.
No IP address, device fingerprint, user agent or other identity data is collected. Audit
entries for ballots contain only `{receipt, weight}`, never the choice. Inclusion proofs
are served by receipt and reveal only the commitment (a salted hash), never the choice or
the account. Managers can see account ids on ballots only through the database; no API
lists ballots with identities.

## Verifiable counts

* Commitment: `sha256("lce-ballot-v1\n" + receipt + "\n" + canonicalChoice + "\n" + weight + "\n" + salt)`
  (returned to the voter at submission together with the salt).
* Snapshot: on close (version 1) and on every later void (version n+1) the service writes
  an immutable `vote_tally_snapshots` row with the tally, ballot count, total weight, the
  sorted commitments and their Merkle root (leaf `sha256(0x00‖commitment)`, node
  `sha256(0x01‖left‖right)`, odd node promoted, fixed empty root). A trigger rejects any
  `UPDATE`, so earlier versions can never change.
* Proof API: `GET …/proof?receipt=…[&version=n]` (active member) returns the snapshot
  version, root, commitment, leaf index and sibling path, plus `included` and the ballot
  status (`active`, `superseded`, `voided`). The participation page re-verifies the path
  in the browser with Web Crypto, and voters can recompute their commitment from their own
  receipt data.
* Recount: `POST …/recount` (`event.manage`) re-derives every active ballot's commitment
  from stored receipt/choice/weight/salt, recomputes the Merkle root and the tally, checks
  that the stored leaves hash to the stored root, and reports `matches`,
  `commitmentMismatches` (ballot ids), `tallyMatches` and both roots. The result is audited
  (`voting.recount`). It does not change data.
* Voids: `POST …/voids {ballotId | receipt, reason}` (`event.manage`, reason required)
  marks the ballot `voided` (the row is kept), appends an immutable `vote_ballot_voids`
  record, audits `voting.ballot_voided` with the reason, and — if the window is closed —
  writes a new snapshot version. `GET …/voids` lists them.

`finalVoteTally` (for LC-30) always returns the latest snapshot version.

## Authorization matrix

| Endpoint | Method | Check |
| --- | --- | --- |
| `…/windows/[windowId]/proof` | GET | active member (receipt is the bearer secret) |
| `…/windows/[windowId]/recount` | POST | `event.manage` |
| `…/windows/[windowId]/voids` | GET / POST | `event.manage` |
| `…/windows/[windowId]/snapshots` | GET | `event.manage` |
| `…/windows/[windowId]/anomalies` | GET / POST (scan) | `event.manage` |
| `…/windows/[windowId]/anomalies/[flagId]` | PATCH `{status, note}` | `event.manage` |

## Tested

Merkle proofs for every leaf of trees of size 1–17 and tamper rejection; detectors;
integration: every receipt verifies against the close snapshot, recount matches, a void
creates version 2 while version 1 stays untouched (also enforced by trigger), proofs per
version, final tally follows the latest version, tampered ballot choice is detected by
recount, voided voters cannot re-vote, timing-cluster flag stored and reviewable with
ballots untouched, idempotent re-scan, cross-tenant denial for proofs, voids, recounts and
flags; handler tests for authorization and error mapping.

Also fixed in this milestone (shared `packages/db/src/audit.ts`): `ORDER BY sequence`
resolved to the `sequence::text` output column, so chains with 10+ entries got duplicate
sequence numbers and failed verification. Queries now order by `audit_events.sequence`;
a regression test covers 12 entries.

## Not claimed

* Snapshot integrity relies on the database and audit chain; roots are not yet published
  to an external transparency log, so a database administrator could rewrite both.
* Detector thresholds are defaults, not tuned on real traffic. No production evidence.
* Proofs show inclusion in the counted set; they do not prove the absence of extra
  ballots (that requires eligibility auditing by managers).
