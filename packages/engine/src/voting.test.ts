import test from "node:test";
import assert from "node:assert/strict";
import { assertVoteAllowed, detectAnomalies, GENESIS, verifyChain, voteHash, voterKey, voteWindowInputSchema, windowState } from "./voting.ts";

test("voter keys are stable per window and unlinkable across windows", () => {
  assert.equal(voterKey("w1", "acct"), voterKey("w1", "acct"));
  assert.notEqual(voterKey("w1", "acct"), voterKey("w2", "acct"));
  assert.match(voterKey("w1", "acct"), /^[0-9a-f]{64}$/);
});

test("hash chain detects tampering, deletion and reordering", () => {
  const votes = [];
  let prev = GENESIS;
  for (let i = 0; i < 4; i += 1) {
    const v = { windowId: "w", voterHash: `v${i}`, entryId: i % 2 ? "a" : "b", weight: "1", castAt: `2026-01-01T00:00:0${i}Z`, prevHash: prev };
    const rowHash = voteHash(v);
    votes.push({ ...v, rowHash });
    prev = rowHash;
  }
  assert.equal(verifyChain(votes), -1);
  assert.equal(verifyChain([...votes.slice(0, 1), ...votes.slice(2)]), 1);
  assert.equal(verifyChain(votes.map((v, i) => i === 2 ? { ...v, entryId: "a" } : v)), 2);
});

test("window rules and vote limits", () => {
  const now = new Date("2026-11-01T10:00:00Z");
  assert.equal(windowState({ status: "open", opensAt: null, closesAt: new Date("2026-11-01T09:00:00Z") }, now), "closed");
  assert.equal(windowState({ status: "scheduled", opensAt: null, closesAt: null }, now), "not_open");
  assert.throws(() => assertVoteAllowed({ state: "open", validOption: true, votesByVoter: 1, maxVotesPerVoter: 1, votesByNetwork: 0, maxVotesPerIp: null }), /vote_limit_reached/);
  assert.throws(() => assertVoteAllowed({ state: "open", validOption: true, votesByVoter: 0, maxVotesPerVoter: 1, votesByNetwork: 5, maxVotesPerIp: 5 }), /network_vote_limit/);
  assert.throws(() => assertVoteAllowed({ state: "open", validOption: false, votesByVoter: 0, maxVotesPerVoter: 1, votesByNetwork: 0, maxVotesPerIp: null }), /invalid_vote_option/);
  assert.equal(voteWindowInputSchema.safeParse({ title: "x", stageId: "6f1d2a3b-1111-4111-8111-111111111111", matchupId: "6f1d2a3b-1111-4111-8111-111111111111" }).success, false);
});

test("anomaly heuristics flag bursts, network concentration and new-account surges", () => {
  const base = Date.parse("2026-11-01T10:00:00Z");
  const votes = [
    ...Array.from({ length: 3 }, (_, m) => ({ castAt: new Date(base + m * 60000), ipHash: `n${m}`, newAccount: false })),
    ...Array.from({ length: 40 }, () => ({ castAt: new Date(base + 5 * 60000), ipHash: "same", newAccount: true }))
  ];
  assert.deepEqual(detectAnomalies(votes).map(a => a.kind).sort(), ["burst", "network_concentration", "new_account_surge"]);
  assert.deepEqual(detectAnomalies(votes.slice(0, 10)), []);
});
