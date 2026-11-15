/**
 * Binary Merkle tree over ballot commitments (hex sha256 strings), used for
 * verifiable vote counts (LC-28/29).
 *
 * * Leaves are the commitments sorted ascending (byte order of the hex string).
 * * leaf = sha256(0x00 || commitmentBytes); node = sha256(0x01 || left || right)
 *   (domain separation prevents leaf/node confusion).
 * * An odd node at the end of a level is promoted unchanged to the next level.
 * * The empty tree root is sha256("lce-merkle-empty-v1").
 */
import { createHash } from "node:crypto";
import { DomainError } from "./index.ts";

const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();

export const EMPTY_MERKLE_ROOT = createHash("sha256").update("lce-merkle-empty-v1", "utf8").digest("hex");

export function merkleLeaf(commitment: string): Buffer {
  if (!HEX64.test(commitment)) throw new DomainError("invalid_commitment");
  return sha256(Buffer.from([0]), Buffer.from(commitment, "hex"));
}

function merkleNode(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.from([1]), left, right);
}

export function sortCommitments(commitments: readonly string[]): string[] {
  const sorted = [...commitments].sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new DomainError("duplicate_commitment");
  }
  return sorted;
}

function levels(sortedCommitments: readonly string[]): Buffer[][] {
  const tree: Buffer[][] = [sortedCommitments.map(merkleLeaf)];
  while (tree[tree.length - 1]!.length > 1) {
    const current = tree[tree.length - 1]!;
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? merkleNode(current[i]!, current[i + 1]!) : current[i]!);
    }
    tree.push(next);
  }
  return tree;
}

export function merkleRoot(commitments: readonly string[]): string {
  if (commitments.length === 0) return EMPTY_MERKLE_ROOT;
  const tree = levels(sortCommitments(commitments));
  return tree[tree.length - 1]![0]!.toString("hex");
}

export interface MerkleProofStep {
  side: "left" | "right";
  hash: string;
}

export interface MerkleProof {
  commitment: string;
  index: number;
  leafCount: number;
  path: MerkleProofStep[];
  root: string;
}

/** Inclusion proof for one commitment, or null when it is not in the set. */
export function merkleProof(commitments: readonly string[], commitment: string): MerkleProof | null {
  const sorted = sortCommitments(commitments);
  const index = sorted.indexOf(commitment);
  if (index < 0) return null;
  const tree = levels(sorted);
  const path: MerkleProofStep[] = [];
  let position = index;
  for (let level = 0; level < tree.length - 1; level++) {
    const nodes = tree[level]!;
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    if (sibling < nodes.length) {
      path.push({ side: position % 2 === 0 ? "right" : "left", hash: nodes[sibling]!.toString("hex") });
    }
    position = Math.floor(position / 2);
  }
  return { commitment, index, leafCount: sorted.length, path, root: tree[tree.length - 1]![0]!.toString("hex") };
}

/** Recompute the root from a commitment and its path; constant structure, no trust in the server. */
export function verifyMerkleProof(commitment: string, path: readonly MerkleProofStep[], root: string): boolean {
  if (!HEX64.test(root)) return false;
  let hash: Buffer;
  try {
    hash = merkleLeaf(commitment);
  } catch {
    return false;
  }
  for (const step of path) {
    if (!HEX64.test(step.hash) || (step.side !== "left" && step.side !== "right")) return false;
    const sibling = Buffer.from(step.hash, "hex");
    hash = step.side === "right" ? merkleNode(hash, sibling) : merkleNode(sibling, hash);
  }
  return hash.toString("hex") === root;
}
