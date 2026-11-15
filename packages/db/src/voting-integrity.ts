import { DomainError, isUuid } from "@live-competition-engine/domain";
import { normalizeReason } from "@live-competition-engine/domain/audience";
import { merkleProof, merkleRoot, type MerkleProofStep } from "@live-competition-engine/domain/merkle";
import { ballotCommitment, canonicalChoiceJson } from "@live-competition-engine/domain/voting";
import type { TallyMethod, TallyResult } from "@live-competition-engine/domain/voting-tally";
import { ensureCompetition } from "./audience.ts";
import { canonicalJson, recordAudit } from "./audit.ts";
import { requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { detectAndStoreAnomalies, type StoredAnomalyFlag } from "./vote-anomaly-store.ts";
import { computeBallotSet, writeTallySnapshot, type TallySnapshot } from "./vote-snapshots.ts";
import { loadWindow } from "./voting.ts";

interface SnapshotRow {
  id: string;
  version: number;
  reason: "close" | "void";
  tally_method: TallyMethod;
  merkle_root: string;
  ballot_count: number;
  total_weight: number;
  commitments: string[];
  tally: TallyResult;
  created_at: Date;
}

async function readSnapshot(organizationId: string, windowId: string, version?: number): Promise<SnapshotRow> {
  const sql = getSqlClient();
  const [row] = await sql<SnapshotRow[]>`
    SELECT id, version, reason, tally_method, merkle_root, ballot_count, total_weight, commitments, tally, created_at
    FROM vote_tally_snapshots
    WHERE organization_id = ${organizationId} AND window_id = ${windowId}
      ${version === undefined ? sql`` : sql`AND version = ${version}`}
    ORDER BY version DESC LIMIT 1
  `;
  if (!row) throw new DomainError(version === undefined ? "invalid_state_window_not_closed" : "snapshot_not_found");
  return row;
}

export interface SnapshotSummary {
  version: number;
  reason: "close" | "void";
  merkleRoot: string;
  ballotCount: number;
  totalWeight: number;
  tally: TallyResult;
  createdAt: Date;
}

/** All immutable snapshot versions for a window (managers). */
export async function listTallySnapshots(organizationId: string, competitionId: string, windowId: string): Promise<SnapshotSummary[]> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  await loadWindow(sql, organizationId, competitionId, windowId);
  const rows = await sql<SnapshotRow[]>`
    SELECT version, reason, merkle_root, ballot_count, total_weight, tally, created_at FROM vote_tally_snapshots
    WHERE organization_id = ${organizationId} AND window_id = ${windowId} ORDER BY version
  `;
  return rows.map(row => ({ version: row.version, reason: row.reason, merkleRoot: row.merkle_root, ballotCount: row.ballot_count, totalWeight: row.total_weight, tally: row.tally, createdAt: row.created_at }));
}

export interface InclusionProof {
  receipt: string;
  status: "active" | "superseded" | "voided";
  included: boolean;
  snapshotVersion: number;
  merkleRoot: string;
  commitment: string;
  leafIndex: number | null;
  leafCount: number;
  path: MerkleProofStep[];
}

/**
 * Inclusion proof for a receipt against a snapshot (latest by default). The
 * receipt is the bearer secret; the response reveals no identity and no choice,
 * only the commitment the voter can recompute from their own receipt data.
 */
export async function getInclusionProof(
  organizationId: string,
  competitionId: string,
  windowId: string,
  receipt: unknown,
  version?: number
): Promise<InclusionProof> {
  if (typeof receipt !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(receipt)) throw new DomainError("invalid_receipt");
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new DomainError("invalid_version");
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  await loadWindow(sql, organizationId, competitionId, windowId, "none", false);
  const [ballot] = await sql<{ commitment: string; status: InclusionProof["status"] }[]>`
    SELECT commitment, status FROM vote_ballots
    WHERE organization_id = ${organizationId} AND window_id = ${windowId} AND receipt = ${receipt}
  `;
  if (!ballot) throw new DomainError("receipt_not_found");
  const snapshot = await readSnapshot(organizationId, windowId, version);
  const proof = merkleProof(snapshot.commitments, ballot.commitment);
  return {
    receipt, status: ballot.status, included: proof !== null, snapshotVersion: snapshot.version, merkleRoot: snapshot.merkle_root,
    commitment: ballot.commitment, leafIndex: proof?.index ?? null, leafCount: snapshot.commitments.length, path: proof?.path ?? []
  };
}

export interface RecountReport {
  snapshotVersion: number;
  matches: boolean;
  storedMerkleRoot: string;
  recomputedMerkleRoot: string;
  storedLeavesConsistent: boolean;
  tallyMatches: boolean;
  commitmentMismatches: string[];
  ballotCount: number;
  recomputedTally: TallyResult;
}

/**
 * Recompute the latest snapshot from stored ballots: every ballot commitment is
 * re-derived from receipt/choice/weight/salt, then the Merkle root and tally are
 * recomputed and compared with the stored snapshot. Read-only apart from the audit entry.
 */
export async function recountVoteWindow(organizationId: string, competitionId: string, windowId: string, actorAccountId: string): Promise<RecountReport> {
  await ensureCompetition(getSqlClient(), organizationId, competitionId);
  return getSqlClient().begin(async tx => {
    const window = await loadWindow(tx, organizationId, competitionId, windowId, "share");
    const [snapshot] = await tx<SnapshotRow[]>`
      SELECT id, version, reason, tally_method, merkle_root, ballot_count, total_weight, commitments, tally, created_at
      FROM vote_tally_snapshots WHERE organization_id = ${organizationId} AND window_id = ${windowId}
      ORDER BY version DESC LIMIT 1
    `;
    if (!snapshot) throw new DomainError("invalid_state_window_not_closed");
    const set = await computeBallotSet(tx, organizationId, windowId, window.tally_method);
    const commitmentMismatches = set.ballots
      .filter(ballot => ballotCommitment(ballot.receipt, ballot.choice, ballot.weight, ballot.salt) !== ballot.commitment)
      .map(ballot => ballot.id);
    const storedLeavesConsistent = merkleRoot(snapshot.commitments) === snapshot.merkle_root;
    const tallyMatches = canonicalJson(set.tally) === canonicalJson(snapshot.tally);
    const matches = commitmentMismatches.length === 0 && storedLeavesConsistent && tallyMatches && set.merkleRoot === snapshot.merkle_root;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "voting.recount", subjectType: "vote_window", subjectId: windowId,
      details: { competitionId, snapshotVersion: snapshot.version, matches, recomputedMerkleRoot: set.merkleRoot, commitmentMismatchCount: commitmentMismatches.length }
    });
    return {
      snapshotVersion: snapshot.version, matches, storedMerkleRoot: snapshot.merkle_root, recomputedMerkleRoot: set.merkleRoot,
      storedLeavesConsistent, tallyMatches, commitmentMismatches, ballotCount: set.ballots.length, recomputedTally: set.tally
    };
  });
}

/**
 * Exclude a ballot (by id or receipt) with an audited reason. The ballot row is
 * kept (status `voided`), an append-only void record is written and — when the
 * window is already closed — a NEW snapshot version is produced; earlier
 * versions are never modified.
 */
export async function voidBallot(
  organizationId: string,
  competitionId: string,
  windowId: string,
  actorAccountId: string,
  target: { ballotId?: unknown; receipt?: unknown },
  rawReason: unknown,
  now: Date = new Date()
): Promise<{ voidId: string; ballotId: string; snapshot: TallySnapshot | null }> {
  const reason = normalizeReason(rawReason)!;
  const byId = target.ballotId !== undefined;
  if (byId ? !isUuid(target.ballotId) : typeof target.receipt !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(target.receipt)) {
    throw new DomainError("invalid_ballot_reference");
  }
  await ensureCompetition(getSqlClient(), organizationId, competitionId);
  await requireEnabledFeature("voting", { organizationId, eventId: competitionId });
  return getSqlClient().begin(async tx => {
    const window = await loadWindow(tx, organizationId, competitionId, windowId, "update");
    const [ballot] = await tx<{ id: string; status: string; receipt: string }[]>`
      SELECT id, status, receipt FROM vote_ballots
      WHERE organization_id = ${organizationId} AND window_id = ${windowId}
        AND ${byId ? tx`id = ${target.ballotId as string}` : tx`receipt = ${target.receipt as string}`}
      FOR UPDATE
    `;
    if (!ballot) throw new DomainError("ballot_not_found");
    if (ballot.status !== "active") throw new DomainError("invalid_state_ballot_not_active");
    await tx`UPDATE vote_ballots SET status = 'voided', voided_at = ${now} WHERE organization_id = ${organizationId} AND id = ${ballot.id}`;
    const snapshot = window.status === "closed"
      ? await writeTallySnapshot(tx, { organizationId, windowId, method: window.tally_method, actorAccountId, reason: "void" })
      : null;
    const [voided] = await tx<{ id: string }[]>`
      INSERT INTO vote_ballot_voids (organization_id, window_id, ballot_id, reason, voided_by_account_id, snapshot_version, created_at)
      VALUES (${organizationId}, ${windowId}, ${ballot.id}, ${reason}, ${actorAccountId}, ${snapshot?.version ?? null}, ${now})
      RETURNING id
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "voting.ballot_voided", subjectType: "vote_window", subjectId: windowId,
      details: { competitionId, ballotId: ballot.id, receipt: ballot.receipt, reason, snapshotVersion: snapshot?.version ?? null, merkleRoot: snapshot?.merkleRoot ?? null }
    });
    return { voidId: voided!.id, ballotId: ballot.id, snapshot };
  });
}

export async function listBallotVoids(organizationId: string, competitionId: string, windowId: string) {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  await loadWindow(sql, organizationId, competitionId, windowId);
  const rows = await sql<{ id: string; ballot_id: string; reason: string; voided_by_account_id: string; snapshot_version: number | null; created_at: Date }[]>`
    SELECT id, ballot_id, reason, voided_by_account_id, snapshot_version, created_at FROM vote_ballot_voids
    WHERE organization_id = ${organizationId} AND window_id = ${windowId} ORDER BY created_at, id
  `;
  return rows.map(row => ({ id: row.id, ballotId: row.ballot_id, reason: row.reason, voidedByAccountId: row.voided_by_account_id, snapshotVersion: row.snapshot_version, createdAt: row.created_at }));
}

/** Run anomaly detectors now (managers); returns the number of new flags. */
export async function scanVoteAnomalies(organizationId: string, competitionId: string, windowId: string, actorAccountId: string): Promise<{ newFlags: number }> {
  await ensureCompetition(getSqlClient(), organizationId, competitionId);
  return getSqlClient().begin(async tx => {
    const window = await loadWindow(tx, organizationId, competitionId, windowId, "share");
    const newFlags = await detectAndStoreAnomalies(tx, organizationId, windowId, window.opens_at);
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "voting.anomaly_scan", subjectType: "vote_window", subjectId: windowId,
      details: { competitionId, newFlags }
    });
    return { newFlags };
  });
}

export async function listAnomalyFlags(organizationId: string, competitionId: string, windowId: string): Promise<StoredAnomalyFlag[]> {
  const sql = getSqlClient();
  await ensureCompetition(sql, organizationId, competitionId);
  await loadWindow(sql, organizationId, competitionId, windowId);
  const rows = await sql<{ id: string; kind: StoredAnomalyFlag["kind"]; fingerprint: string; details: Record<string, unknown>; status: StoredAnomalyFlag["status"]; created_at: Date }[]>`
    SELECT id, kind, fingerprint, details, status, created_at FROM vote_anomaly_flags
    WHERE organization_id = ${organizationId} AND window_id = ${windowId} ORDER BY created_at, id
  `;
  return rows.map(row => ({ id: row.id, kind: row.kind, fingerprint: row.fingerprint, details: row.details, status: row.status, createdAt: row.created_at }));
}

/** open → reviewed | dismissed, with an optional note. Reviewing never changes ballots. */
export async function reviewAnomalyFlag(
  organizationId: string,
  competitionId: string,
  windowId: string,
  flagId: string,
  actorAccountId: string,
  status: unknown,
  rawNote: unknown
): Promise<void> {
  if (status !== "reviewed" && status !== "dismissed") throw new DomainError("invalid_status");
  if (!isUuid(flagId)) throw new DomainError("anomaly_flag_not_found");
  const note = normalizeReason(rawNote, false);
  await ensureCompetition(getSqlClient(), organizationId, competitionId);
  await getSqlClient().begin(async tx => {
    await loadWindow(tx, organizationId, competitionId, windowId);
    const rows = await tx`
      UPDATE vote_anomaly_flags SET status = ${status}, reviewed_by_account_id = ${actorAccountId}, reviewed_at = now(), review_note = ${note}
      WHERE organization_id = ${organizationId} AND window_id = ${windowId} AND id = ${flagId} AND status = 'open'
      RETURNING id
    `;
    if (rows.length !== 1) throw new DomainError("anomaly_flag_not_found");
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "voting.anomaly_reviewed", subjectType: "vote_window", subjectId: windowId,
      details: { competitionId, flagId, status, note }
    });
  });
}

/** Exposed for clients that verify commitments themselves. */
export { ballotCommitment, canonicalChoiceJson };
