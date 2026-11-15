import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMPTY_MERKLE_ROOT, merkleProof, merkleRoot, verifyMerkleProof } from "./merkle";

const commitment = (seed: string) => createHash("sha256").update(seed).digest("hex");
const set = (count: number) => Array.from({ length: count }, (_, i) => commitment(`ballot-${i}`));

describe("merkle tree", () => {
  it("has a fixed empty root and a domain-separated single leaf root", () => {
    expect(merkleRoot([])).toBe(EMPTY_MERKLE_ROOT);
    const one = commitment("x");
    expect(merkleRoot([one])).not.toBe(one);
    expect(merkleRoot([one])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of input order", () => {
    const values = set(7);
    expect(merkleRoot(values)).toBe(merkleRoot([...values].reverse()));
  });

  it("changes when any commitment is added, removed or altered", () => {
    const values = set(5);
    const root = merkleRoot(values);
    expect(merkleRoot(values.slice(1))).not.toBe(root);
    expect(merkleRoot([...values, commitment("extra")])).not.toBe(root);
    expect(merkleRoot([commitment("changed"), ...values.slice(1)])).not.toBe(root);
  });

  it("produces verifiable inclusion proofs for every leaf of many tree sizes", () => {
    for (const size of [1, 2, 3, 4, 5, 8, 9, 17]) {
      const values = set(size);
      const root = merkleRoot(values);
      for (const value of values) {
        const proof = merkleProof(values, value)!;
        expect(proof.root).toBe(root);
        expect(verifyMerkleProof(value, proof.path, root)).toBe(true);
      }
    }
  });

  it("rejects proofs for other commitments, tampered paths and wrong roots", () => {
    const values = set(6);
    const root = merkleRoot(values);
    const proof = merkleProof(values, values[2]!)!;
    expect(merkleProof(values, commitment("absent"))).toBeNull();
    expect(verifyMerkleProof(values[3]!, proof.path, root)).toBe(false);
    expect(verifyMerkleProof(values[2]!, proof.path, merkleRoot(values.slice(1)))).toBe(false);
    const tampered = proof.path.map((step, index) => index === 0 ? { ...step, side: step.side === "left" ? "right" as const : "left" as const } : step);
    expect(verifyMerkleProof(values[2]!, tampered, root)).toBe(false);
    expect(verifyMerkleProof("not-hex", proof.path, root)).toBe(false);
    expect(verifyMerkleProof(values[2]!, [{ side: "left", hash: "zz" }], root)).toBe(false);
  });

  it("rejects duplicate or malformed commitments", () => {
    const value = commitment("dup");
    expect(() => merkleRoot([value, value])).toThrow("duplicate_commitment");
    expect(() => merkleRoot(["ABC"])).toThrow("invalid_commitment");
  });
});
