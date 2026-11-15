import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DomainError } from "@live-competition-engine/domain";
import { verifyMerkleProof } from "@live-competition-engine/domain/merkle";
import { ballotCommitment } from "@live-competition-engine/domain/voting";
import { acceptAudienceTerms, updateAudienceSettings } from "./audience.ts";
import { listAuditEvents, recordAudit, verifyAuditChain, type Sql } from "./audit.ts";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createEntry, createTenant, enableFeature } from "./test-fixtures.ts";
import { cleanupTenants } from "./audience-fixtures.ts";
import { castBallot, closeVoteWindow, createVoteWindow, finalVoteTally, transitionVoteWindow } from "./voting.ts";
import {
  getInclusionProof,
  listAnomalyFlags,
  listBallotVoids,
  listTallySnapshots,
  recountVoteWindow,
  reviewAnomalyFlag,
  scanVoteAnomalies,
  voidBallot
} from "./voting-integrity.ts";

const tenants: string[] = [];
const accounts: string[] = [];
after(async () => {
  await cleanupTenants(tenants, accounts);
  await closeDatabaseConnection();
});

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof DomainError, String(error));
  assert.equal(error.code, expected);
  return true;
};
const key = () => randomUUID();
const recordAuditForTest = (tx: Sql, org: string, i: number) =>
  recordAudit(tx, { organizationId: org, actorAccountId: null, action: "voting.test_event", subjectType: "vote_window", subjectId: org, details: { i } });

async function setup(voters = 4) {
  const org = await createTenant();
  tenants.push(org);
  const producer = await createAccount(org);
  accounts.push(producer);
  const competition = await createCompetition(org);
  await enableFeature("voting", org, producer);
  await updateAudienceSettings(org, competition, producer, { termsVersion: "v1" }, 0);
  const entries = [await createEntry(org, competition), await createEntry(org, competition)];
  const members: string[] = [];
  for (let i = 0; i < voters; i++) {
    const member = await createAccount(org);
    accounts.push(member);
    await acceptAudienceTerms(org, competition, member, "v1");
    members.push(member);
  }
  const now = new Date();
  const window = await createVoteWindow(org, competition, producer, {
    label: "Integrity", opensAt: new Date(now.getTime() - 60_000).toISOString(), closesAt: new Date(now.getTime() + 3_600_000).toISOString(),
    options: entries.map((entry, index) => ({ entryId: entry.entryId, label: `Option ${index}` }))
  });
  await transitionVoteWindow(org, competition, window.id, producer, "publish", 1, now);
  return { org, producer, competition, members, window, now };
}

test("receipts verify against the snapshot Merkle root; recount matches; voids create new versions", async () => {
  const ctx = await setup(4);
  const [a, b] = ctx.window.options;
  const receipts = [];
  for (const [index, member] of ctx.members.entries()) {
    const at = new Date(ctx.now.getTime() + index * 1000);
    receipts.push(await castBallot(ctx.org, ctx.competition, ctx.window.id, { accountId: member, sessionId: randomUUID() }, { optionId: index < 3 ? a!.id : b!.id }, key(), at));
  }
  await assert.rejects(getInclusionProof(ctx.org, ctx.competition, ctx.window.id, receipts[0]!.receipt), code("invalid_state_window_not_closed"));
  const { snapshot } = await closeVoteWindow(ctx.org, ctx.competition, ctx.window.id, ctx.producer, new Date(ctx.now.getTime() + 10_000));
  assert.equal(snapshot.version, 1);

  for (const receipt of receipts) {
    // The voter recomputes their own commitment, then checks the server's path against the published root.
    assert.equal(ballotCommitment(receipt.receipt, receipt.choice, receipt.weight, receipt.salt), receipt.commitment);
    const proof = await getInclusionProof(ctx.org, ctx.competition, ctx.window.id, receipt.receipt);
    assert.equal(proof.included, true);
    assert.equal(proof.merkleRoot, snapshot.merkleRoot);
    assert.equal(verifyMerkleProof(receipt.commitment, proof.path, snapshot.merkleRoot), true);
  }
  await assert.rejects(getInclusionProof(ctx.org, ctx.competition, ctx.window.id, "A".repeat(22)), code("receipt_not_found"));
  await assert.rejects(getInclusionProof(ctx.org, ctx.competition, ctx.window.id, "bad"), code("invalid_receipt"));

  const recount = await recountVoteWindow(ctx.org, ctx.competition, ctx.window.id, ctx.producer);
  assert.equal(recount.matches, true);
  assert.equal(recount.recomputedMerkleRoot, snapshot.merkleRoot);

  await assert.rejects(voidBallot(ctx.org, ctx.competition, ctx.window.id, ctx.producer, { receipt: receipts[0]!.receipt }, ""), code("invalid_reason"));
  const voided = await voidBallot(ctx.org, ctx.competition, ctx.window.id, ctx.producer, { receipt: receipts[0]!.receipt }, "duplicate account confirmed");
  assert.equal(voided.snapshot?.version, 2);
  assert.equal(voided.snapshot?.ballotCount, 3);
  await assert.rejects(voidBallot(ctx.org, ctx.competition, ctx.window.id, ctx.producer, { ballotId: voided.ballotId }, "again"), code("invalid_state_ballot_not_active"));

  const versions = await listTallySnapshots(ctx.org, ctx.competition, ctx.window.id);
  assert.deepEqual(versions.map(version => [version.version, version.reason, version.ballotCount]), [[1, "close", 4], [2, "void", 3]]);
  assert.equal(versions[0]!.merkleRoot, snapshot.merkleRoot); // the old version is untouched
  const latest = await getInclusionProof(ctx.org, ctx.competition, ctx.window.id, receipts[0]!.receipt);
  assert.deepEqual([latest.status, latest.included, latest.snapshotVersion], ["voided", false, 2]);
  assert.equal((await getInclusionProof(ctx.org, ctx.competition, ctx.window.id, receipts[0]!.receipt, 1)).included, true);
  const final = await finalVoteTally(ctx.org, ctx.competition, ctx.window.id);
  assert.equal(final.snapshotVersion, 2);
  assert.deepEqual(final.tally.rows.map(row => row.score), [2, 1]);
  assert.equal((await recountVoteWindow(ctx.org, ctx.competition, ctx.window.id, ctx.producer)).matches, true);

  // Snapshots are immutable at the database level.
  await assert.rejects(getSqlClient()`UPDATE vote_tally_snapshots SET ballot_count = 99 WHERE window_id = ${ctx.window.id}`, /immutable/);
  const voids = await listBallotVoids(ctx.org, ctx.competition, ctx.window.id);
  assert.deepEqual(voids.map(row => [row.reason, row.snapshotVersion]), [["duplicate account confirmed", 2]]);
  const audit = await listAuditEvents(ctx.org, { subjectType: "vote_window", subjectId: ctx.window.id, limit: 50 });
  const voidAudit = audit.find(row => row.action === "voting.ballot_voided");
  assert.equal(voidAudit?.details.reason, "duplicate account confirmed");
  assert.equal((await verifyAuditChain(ctx.org)).valid, true);
});

test("recount detects tampered ballots", async () => {
  const ctx = await setup(2);
  const [a, b] = ctx.window.options;
  await castBallot(ctx.org, ctx.competition, ctx.window.id, { accountId: ctx.members[0]!, sessionId: randomUUID() }, { optionId: a!.id }, key(), ctx.now);
  const target = await castBallot(ctx.org, ctx.competition, ctx.window.id, { accountId: ctx.members[1]!, sessionId: randomUUID() }, { optionId: a!.id }, key(), ctx.now);
  await closeVoteWindow(ctx.org, ctx.competition, ctx.window.id, ctx.producer, ctx.now);
  await getSqlClient()`UPDATE vote_ballots SET choice = ${getSqlClient().json({ optionId: b!.id })} WHERE id = ${target.ballotId}`;
  const report = await recountVoteWindow(ctx.org, ctx.competition, ctx.window.id, ctx.producer);
  assert.equal(report.matches, false);
  assert.equal(report.tallyMatches, false);
  assert.deepEqual(report.commitmentMismatches, [target.ballotId]);
  const audit = await listAuditEvents(ctx.org, { subjectType: "vote_window", subjectId: ctx.window.id });
  assert.equal(audit.find(row => row.action === "voting.recount")?.details.matches, false);
});

test("a voided voter cannot vote again in an open window", async () => {
  const ctx = await setup(1);
  const voter = { accountId: ctx.members[0]!, sessionId: randomUUID() };
  const ballot = await castBallot(ctx.org, ctx.competition, ctx.window.id, voter, { optionId: ctx.window.options[0]!.id }, key(), ctx.now);
  const voided = await voidBallot(ctx.org, ctx.competition, ctx.window.id, ctx.producer, { ballotId: ballot.ballotId }, "ineligible");
  assert.equal(voided.snapshot, null); // window still open: no snapshot yet
  await assert.rejects(castBallot(ctx.org, ctx.competition, ctx.window.id, voter, { optionId: ctx.window.options[1]!.id }, key(), ctx.now), code("ballot_voided"));
});

test("anomaly detection stores reviewable flags and never deletes ballots", async () => {
  const ctx = await setup(6);
  // Six ballots at the identical instant: a timing cluster.
  for (const member of ctx.members) {
    await castBallot(ctx.org, ctx.competition, ctx.window.id, { accountId: member, sessionId: randomUUID() }, { optionId: ctx.window.options[0]!.id }, key(), ctx.now);
  }
  const scan = await scanVoteAnomalies(ctx.org, ctx.competition, ctx.window.id, ctx.producer);
  assert.ok(scan.newFlags >= 1);
  assert.deepEqual(await scanVoteAnomalies(ctx.org, ctx.competition, ctx.window.id, ctx.producer), { newFlags: 0 });
  const flags = await listAnomalyFlags(ctx.org, ctx.competition, ctx.window.id);
  const cluster = flags.find(flag => flag.kind === "timing_cluster");
  assert.ok(cluster);
  assert.equal((cluster.details.ballotIds as string[]).length, 6);
  // All six ballots were created by accounts made seconds ago: new-account ratio is above threshold only for >= 20 ballots.
  assert.ok(!flags.some(flag => flag.kind === "new_account_ratio"));
  await reviewAnomalyFlag(ctx.org, ctx.competition, ctx.window.id, cluster.id, ctx.producer, "reviewed", "venue wifi batch");
  await assert.rejects(reviewAnomalyFlag(ctx.org, ctx.competition, ctx.window.id, cluster.id, ctx.producer, "dismissed", null), code("anomaly_flag_not_found"));
  const [{ count }] = (await getSqlClient()`SELECT count(*)::int AS count FROM vote_ballots WHERE window_id = ${ctx.window.id} AND status = 'active'`) as unknown as [{ count: number }];
  assert.equal(count, 6);
});

test("regression: audit chains with 10+ entries stay ordered numerically", async () => {
  const org = await createTenant();
  tenants.push(org);
  for (let i = 0; i < 12; i++) {
    await getSqlClient().begin(tx => recordAuditForTest(tx, org, i));
  }
  const chain = await verifyAuditChain(org);
  assert.deepEqual([chain.valid, chain.count], [true, 12]);
  const latest = await listAuditEvents(org, { limit: 3 });
  assert.deepEqual(latest.map(row => row.sequence), ["12", "11", "10"]);
});

test("integrity operations are tenant isolated", async () => {
  const a = await setup(1);
  const b = await setup(1);
  const ballot = await castBallot(a.org, a.competition, a.window.id, { accountId: a.members[0]!, sessionId: randomUUID() }, { optionId: a.window.options[0]!.id }, key(), a.now);
  await closeVoteWindow(a.org, a.competition, a.window.id, a.producer, a.now);
  await assert.rejects(getInclusionProof(b.org, b.competition, a.window.id, ballot.receipt), code("vote_window_not_found"));
  await assert.rejects(getInclusionProof(b.org, a.competition, a.window.id, ballot.receipt), code("competition_not_found"));
  await assert.rejects(voidBallot(b.org, b.competition, a.window.id, b.producer, { receipt: ballot.receipt }, "x"), code("vote_window_not_found"));
  // b's own window cannot reach a's ballot either.
  await assert.rejects(voidBallot(b.org, b.competition, b.window.id, b.producer, { receipt: ballot.receipt }, "x"), code("ballot_not_found"));
  await assert.rejects(recountVoteWindow(b.org, b.competition, a.window.id, b.producer), code("vote_window_not_found"));
  await assert.rejects(listAnomalyFlags(b.org, b.competition, a.window.id), code("vote_window_not_found"));
});
