import { merkleRoot } from "@live-competition-engine/domain/merkle";
import { tallyBallots, type CanonicalChoice, type TallyMethod, type TallyResult } from "@live-competition-engine/domain/voting-tally";
import type { Sql } from "./audit.ts";

export interface TallySnapshot {
  id: string;
  windowId: string;
  version: number;
  reason: "close" | "void";
  merkleRoot: string;
  ballotCount: number;
  totalWeight: number;
  tally: TallyResult;
  createdAt: Date;
}

/** Tally + Merkle root over the window's active ballots, recomputed from storage. */
export async function computeBallotSet(tx: Sql, organizationId: string, windowId: string, method: TallyMethod) {
  const options = await tx<{ id: string }[]>`
    SELECT id FROM vote_window_options WHERE organization_id = ${organizationId} AND window_id = ${windowId} ORDER BY ordinal
  `;
  const ballots = await tx<{ id: string; receipt: string; choice: CanonicalChoice; weight: number; salt: string; commitment: string }[]>`
    SELECT id, receipt, choice, weight, salt, commitment FROM vote_ballots
    WHERE organization_id = ${organizationId} AND window_id = ${windowId} AND status = 'active'
    ORDER BY commitment
  `;
  const commitments = ballots.map(ballot => ballot.commitment);
  return {
    ballots,
    commitments,
    merkleRoot: merkleRoot(commitments),
    tally: tallyBallots(method, options.map(option => option.id), ballots.map(ballot => ({ weight: ballot.weight, choice: ballot.choice })))
  };
}

/**
 * Append the next immutable snapshot version for a window inside the caller's
 * transaction (the caller holds the window row lock).
 */
export async function writeTallySnapshot(
  tx: Sql,
  input: { organizationId: string; windowId: string; method: TallyMethod; actorAccountId: string | null; reason: "close" | "void" }
): Promise<TallySnapshot> {
  const set = await computeBallotSet(tx, input.organizationId, input.windowId, input.method);
  const [row] = await tx<{ id: string; version: number; created_at: Date }[]>`
    INSERT INTO vote_tally_snapshots (organization_id, window_id, version, reason, tally_method, merkle_root, ballot_count,
      total_weight, commitments, tally, created_by_account_id)
    SELECT ${input.organizationId}, ${input.windowId}, coalesce(max(version), 0) + 1, ${input.reason}, ${input.method},
      ${set.merkleRoot}, ${set.tally.ballotCount}, ${set.tally.totalWeight}, ${tx.json(set.commitments)},
      ${tx.json(set.tally as never)}, ${input.actorAccountId}
    FROM vote_tally_snapshots WHERE window_id = ${input.windowId}
    RETURNING id, version, created_at
  `;
  return {
    id: row!.id, windowId: input.windowId, version: row!.version, reason: input.reason, merkleRoot: set.merkleRoot,
    ballotCount: set.tally.ballotCount, totalWeight: set.tally.totalWeight, tally: set.tally, createdAt: row!.created_at
  };
}
