import test, { after } from "node:test";
import assert from "node:assert/strict";
import { AuthenticationService } from "@live-competition-engine/auth";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createPostgresAuthStore } from "./auth-store.ts";
import { createAccount, createCompetition, createEntry, createTenant } from "./test-fixtures.ts";
import { createRound } from "./judging-fixtures.ts";
import {
  acceptInvitation, assertPerformanceAccess, declareConflict, inviteJudge, listCompetitionJudges, listInvitations,
  listJudgeAssignments, listRecusals, recuseJudge, rescindRecusal, revokeInvitation, updateJudgeStatus
} from "./judges.ts";
import { assignJudgeToRound, getRoundPanel, setRoundLineup } from "./selection.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

const email = (account: string) => `fx-${account}@example.test`;
const auth = new AuthenticationService(createPostgresAuthStore());

async function setup() {
  const org = await createTenant();
  const producer = await createAccount(org);
  const competition = await createCompetition(org);
  return { org, producer, competition };
}

async function onboard(org: string, competition: string, producer: string, verify = true) {
  const account = await createAccount(org);
  const { token } = await inviteJudge(org, competition, producer, { email: email(account).toUpperCase(), displayName: "Judge" });
  const { judgeId } = await acceptInvitation(org, competition, account, token);
  if (verify) await updateJudgeStatus(org, competition, producer, judgeId, { status: "verified", expectedRevision: 1 });
  return { account, judgeId };
}

test("invite → accept links the account and grants a competition-scoped judge role", async () => {
  const { org, producer, competition } = await setup();
  const account = await createAccount(org);
  const { invitation, token } = await inviteJudge(org, competition, producer, { email: email(account), displayName: "Pat", expiresInHours: 2 });
  assert.equal(invitation.status, "open");
  const [stored] = await getSqlClient()<{ token_hash: string }[]>`SELECT token_hash FROM judge_invitations WHERE id = ${invitation.id}`;
  assert.notEqual(stored!.token_hash, token);
  const accepted = await acceptInvitation(org, competition, account, token);
  assert.equal(accepted.status, "active");
  const { token: session } = await auth.issueSession(account);
  const principal = await auth.authorizeAction(`Bearer ${session}`, "judging.score", { organizationId: org, competitionId: competition });
  assert.equal(principal.role, "judge");
  const otherCompetition = await createCompetition(org);
  await assert.rejects(auth.authorizeAction(`Bearer ${session}`, "judging.score", { organizationId: org, competitionId: otherCompetition }), /forbidden/);
  await assert.rejects(acceptInvitation(org, competition, account, token), { code: "invitation_used_conflict" });
  assert.equal((await listInvitations(org, competition))[0]!.status, "accepted");
  const [judge] = await listCompetitionJudges(org, competition);
  assert.deepEqual([judge!.status, judge!.linkedAccount, judge!.revision], ["active", true, 1]);
  const audit = await getSqlClient()<{ details: Record<string, unknown> }[]>`SELECT details FROM audit_events WHERE chain_key = ${org} AND action = 'judge.invited'`;
  assert.ok(!JSON.stringify(audit).includes(email(account)), "audit log does not store the invited email");
});

test("acceptance is single use under concurrency", async () => {
  const { org, producer, competition } = await setup();
  const account = await createAccount(org);
  const { token } = await inviteJudge(org, competition, producer, { email: email(account), displayName: "Racer" });
  const results = await Promise.allSettled([1, 2, 3].map(() => acceptInvitation(org, competition, account, token)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  for (const r of results.filter(r => r.status === "rejected")) assert.equal((r as PromiseRejectedResult).reason.code, "invitation_used_conflict");
  const [grants] = await getSqlClient()<{ n: number }[]>`SELECT count(*)::int AS n FROM role_grants WHERE account_id = ${account} AND role = 'judge'`;
  assert.equal(grants!.n, 1);
});

test("email mismatch, expiry, revocation and re-invitation fail closed", async () => {
  const { org, producer, competition } = await setup();
  const invited = await createAccount(org);
  const intruder = await createAccount(org);
  const now = new Date();
  const { token } = await inviteJudge(org, competition, producer, { email: email(invited), displayName: "A", expiresInHours: 1 }, now);
  await assert.rejects(acceptInvitation(org, competition, intruder, token), { code: "invitation_email_mismatch" });
  await assert.rejects(acceptInvitation(org, competition, invited, token, new Date(now.getTime() + 3_600_000)), { code: "invitation_expired" });
  const second = await inviteJudge(org, competition, producer, { email: email(invited), displayName: "A" }, now);
  await assert.rejects(acceptInvitation(org, competition, invited, token, now), { code: "invitation_revoked" });
  await revokeInvitation(org, competition, producer, second.invitation.id);
  await assert.rejects(acceptInvitation(org, competition, invited, second.token), { code: "invitation_revoked" });
  await assert.rejects(acceptInvitation(org, competition, invited, "x".repeat(43)), { code: "invitation_not_found" });
});

test("verification, suspension and removal manage the role grant and panels with revisions", async () => {
  const { org, producer, competition } = await setup();
  const round = await createRound(org, competition);
  const { account, judgeId } = await onboard(org, competition, producer, false);
  await assert.rejects(updateJudgeStatus(org, competition, producer, judgeId, { status: "verified", expectedRevision: 7 }), { code: "judge_revision_conflict" });
  let view = await updateJudgeStatus(org, competition, producer, judgeId, { status: "verified", expectedRevision: 1 });
  assert.equal(view.status, "verified");
  assert.ok(view.verifiedAt);
  await assignJudgeToRound(org, competition, round, producer, { judgeId });
  view = await updateJudgeStatus(org, competition, producer, judgeId, { status: "suspended", expectedRevision: 2, reason: "Pending review" });
  const { token: session } = await auth.issueSession(account);
  await assert.rejects(auth.authorizeAction(`Bearer ${session}`, "judging.score", { organizationId: org, competitionId: competition }), /forbidden/);
  view = await updateJudgeStatus(org, competition, producer, judgeId, { status: "active", expectedRevision: 3 });
  assert.equal((await auth.authorizeAction(`Bearer ${session}`, "judging.score", { organizationId: org, competitionId: competition })).role, "judge");
  assert.equal(view.verifiedAt, null, "reactivation requires re-verification");
  await updateJudgeStatus(org, competition, producer, judgeId, { status: "removed", expectedRevision: 4 });
  assert.equal((await getRoundPanel(org, competition, round)).assigned.length, 0);
  await assert.rejects(updateJudgeStatus(org, competition, producer, judgeId, { status: "active", expectedRevision: 5 }), { code: "invalid_state_transition" });
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("judges see only assigned rounds; recusals block access until a producer rescinds", async () => {
  const { org, producer, competition } = await setup();
  const [r1, r2] = [await createRound(org, competition, 1), await createRound(org, competition, 2)];
  const [a, b] = [await createEntry(org, competition, "Alpha"), await createEntry(org, competition, "Beta")];
  const l1 = await setRoundLineup(org, competition, r1, producer, { entryIds: [a.entryId, b.entryId], expectedRevision: 0 });
  const l2 = await setRoundLineup(org, competition, r2, producer, { entryIds: [a.entryId], expectedRevision: 0 });
  const { account, judgeId } = await onboard(org, competition, producer);
  await assignJudgeToRound(org, competition, r1, producer, { judgeId, role: "head" });
  const sql = getSqlClient();
  const assignments = await listJudgeAssignments(org, competition, account);
  assert.deepEqual(assignments.rounds.map(r => r.roundId), [r1]);
  assert.deepEqual(assignments.rounds[0]!.performances.map(p => p.displayName), ["Alpha", "Beta"]);
  await assert.rejects(assertPerformanceAccess(sql, org, competition, account, r2, l2.slots[0]!.performanceId, "score"), { code: "performance_not_found" });
  const pa = l1.slots[0]!.performanceId;
  assert.equal((await assertPerformanceAccess(sql, org, competition, account, r1, pa, "score")).panelRole, "head");

  const declared = await declareConflict(org, competition, account, { entryId: a.entryId, reason: "Former student" });
  assert.equal((await declareConflict(org, competition, account, { entryId: a.entryId, reason: "again" })).id, declared.id, "idempotent");
  await assert.rejects(assertPerformanceAccess(sql, org, competition, account, r1, pa, "score"), { code: "judge_recused" });
  assert.equal((await listJudgeAssignments(org, competition, account)).rounds[0]!.performances[0]!.recused, true);
  await rescindRecusal(org, competition, producer, declared.id, "Relationship ended years ago");
  await assertPerformanceAccess(sql, org, competition, account, r1, pa, "score");
  await recuseJudge(org, competition, producer, { judgeId, entryId: b.entryId, reason: "Sponsor relationship" });
  await assert.rejects(assertPerformanceAccess(sql, org, competition, account, r1, l1.slots[1]!.performanceId, "view"), { code: "judge_recused" });
  const recusals = await listRecusals(org, competition, { judgeId });
  assert.deepEqual(recusals.map(r => [r.source, r.rescindedAt !== null]).sort(), [["producer", false], ["self_declared", true]]);
  await assert.rejects(rescindRecusal(org, competition, producer, declared.id, "twice"), { code: "recusal_not_found" });

  const outsider = await createAccount(org);
  await assert.rejects(listJudgeAssignments(org, competition, outsider), { code: "judge_not_found" });
});

test("unverified judges may view but not score", async () => {
  const { org, producer, competition } = await setup();
  const round = await createRound(org, competition);
  const entry = await createEntry(org, competition);
  const lineup = await setRoundLineup(org, competition, round, producer, { entryIds: [entry.entryId], expectedRevision: 0 });
  const { account, judgeId } = await onboard(org, competition, producer, false);
  await assignJudgeToRound(org, competition, round, producer, { judgeId });
  const sql = getSqlClient();
  await assertPerformanceAccess(sql, org, competition, account, round, lineup.slots[0]!.performanceId, "view");
  await assert.rejects(assertPerformanceAccess(sql, org, competition, account, round, lineup.slots[0]!.performanceId, "score"), { code: "judge_not_verified" });
});

test("tenant isolation for invitations and recusals", async () => {
  const one = await setup();
  const two = await setup();
  const account = await createAccount(one.org);
  await getSqlClient()`INSERT INTO organization_memberships (organization_id, account_id) VALUES (${two.org}, ${account})`;
  const { token } = await inviteJudge(one.org, one.competition, one.producer, { email: email(account), displayName: "X" });
  await assert.rejects(acceptInvitation(two.org, two.competition, account, token), { code: "invitation_not_found" });
  await assert.rejects(acceptInvitation(two.org, one.competition, account, token), { code: "invitation_not_found" });
  await assert.rejects(inviteJudge(two.org, one.competition, two.producer, { email: "a@b.example", displayName: "X" }), { code: "competition_not_found" });
  const { judgeId } = await onboard(two.org, two.competition, two.producer);
  const foreignEntry = await createEntry(one.org, one.competition);
  await assert.rejects(recuseJudge(two.org, two.competition, two.producer, { judgeId, entryId: foreignEntry.entryId, reason: "x" }), { code: "entry_not_found" });
  assert.equal((await listInvitations(two.org, one.competition)).length, 0);
});
