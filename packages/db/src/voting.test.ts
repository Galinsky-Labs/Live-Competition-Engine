import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DomainError } from "@live-competition-engine/domain";
import { merkleRoot } from "@live-competition-engine/domain/merkle";
import { acceptAudienceTerms, updateAudienceSettings } from "./audience.ts";
import { listAuditEvents } from "./audit.ts";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createEntry, createTenant, enableFeature, grantRole } from "./test-fixtures.ts";
import { cleanupTenants } from "./audience-fixtures.ts";
import {
  castBallot,
  closeVoteWindow,
  createVoteWindow,
  finalVoteTally,
  getVoteResults,
  getVoteWindow,
  listVoteWindows,
  transitionVoteWindow
} from "./voting.ts";

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
const key = () => randomUUID().replaceAll("-", "");
const voter = (accountId: string) => ({ accountId, sessionId: randomUUID() });

async function setup() {
  const org = await createTenant();
  tenants.push(org);
  const producer = await createAccount(org);
  accounts.push(producer);
  const competition = await createCompetition(org);
  await enableFeature("voting", org, producer);
  await updateAudienceSettings(org, competition, producer, { termsVersion: "v1" }, 0);
  const entries = [await createEntry(org, competition), await createEntry(org, competition), await createEntry(org, competition)];
  const members: string[] = [];
  for (let i = 0; i < 6; i++) {
    const member = await createAccount(org);
    accounts.push(member);
    await acceptAudienceTerms(org, competition, member, "v1");
    members.push(member);
  }
  return { org, producer, competition, entries, members };
}

async function openWindow(ctx: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}, now = new Date()) {
  const window = await createVoteWindow(ctx.org, ctx.competition, ctx.producer, {
    label: "Audience vote",
    opensAt: new Date(now.getTime() - 60_000).toISOString(),
    closesAt: new Date(now.getTime() + 3_600_000).toISOString(),
    options: ctx.entries.map((entry, index) => ({ entryId: entry.entryId, label: `Option ${index + 1}` })),
    ...extra
  });
  await transitionVoteWindow(ctx.org, ctx.competition, window.id, ctx.producer, "publish", 1, now);
  return getVoteWindow(ctx.org, ctx.competition, window.id, { isManager: true, now });
}

test("single-choice window: idempotent ballots, one per account, server-enforced close and snapshot", async () => {
  const ctx = await setup();
  const now = new Date();
  const window = await openWindow(ctx, {}, now);
  const [a, b, c] = window.options;
  const k = key();
  const first = await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { optionId: a!.id }, k, now);
  const retry = await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { optionId: a!.id }, k, now);
  assert.equal(retry.receipt, first.receipt);
  assert.equal(retry.replayed, true);
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { optionId: b!.id }, k, now), code("idempotency_conflict"));
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { optionId: b!.id }, key(), now), code("vote_conflict"));
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[1]!), { optionId: randomUUID() }, key(), now), code("invalid_ballot"));
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[1]!), { optionId: a!.id }, "short", now), code("invalid_idempotency_key"));
  await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[1]!), { optionId: b!.id }, key(), now);
  await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[2]!), { optionId: b!.id }, key(), now);
  await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[3]!), { optionId: c!.id }, key(), now);

  // Hidden until close for members; managers see the live tally.
  assert.deepEqual(await getVoteResults(ctx.org, ctx.competition, window.id, { isManager: false, now }), { visible: false, phase: "open" });
  const live = await getVoteResults(ctx.org, ctx.competition, window.id, { isManager: true, now });
  assert.ok(live.visible && live.source === "live" && live.tally.winners[0] === b!.id);
  await assert.rejects(finalVoteTally(ctx.org, ctx.competition, window.id), code("invalid_state_window_not_closed"));

  // After the scheduled close the server refuses ballots even if nobody closed the window.
  const late = new Date(window.closesAt.getTime() + 1);
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[4]!), { optionId: a!.id }, key(), late), code("invalid_state_window_not_open"));

  const closed = await closeVoteWindow(ctx.org, ctx.competition, window.id, ctx.producer, late);
  assert.equal(closed.window.status, "closed");
  assert.equal(closed.snapshot.version, 1);
  assert.equal(closed.snapshot.ballotCount, 4);
  const commitments = (await getSqlClient()<{ commitment: string }[]>`SELECT commitment FROM vote_ballots WHERE window_id = ${window.id} AND status = 'active'`).map(row => row.commitment);
  assert.equal(closed.snapshot.merkleRoot, merkleRoot(commitments));
  await assert.rejects(closeVoteWindow(ctx.org, ctx.competition, window.id, ctx.producer, late), code("invalid_state_transition"));

  // A retried request after close still returns the original receipt.
  assert.equal((await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { optionId: a!.id }, k, late)).receipt, first.receipt);
  const final = await finalVoteTally(ctx.org, ctx.competition, window.id);
  assert.equal(final.source, "snapshot");
  assert.deepEqual(final.tally.rows.map(row => [row.optionId, row.score, row.rank]), [[b!.id, 2, 1], [a!.id, 1, 2], [c!.id, 1, 2]]);
  const memberView = await getVoteResults(ctx.org, ctx.competition, window.id, { isManager: false, now: late });
  assert.ok(memberView.visible && memberView.snapshotVersion === 1);

  // Ballot audit carries the receipt but never the choice.
  const audit = await listAuditEvents(ctx.org, { subjectType: "vote_window", subjectId: window.id, limit: 50 });
  const cast = audit.filter(row => row.action === "voting.ballot_cast");
  assert.equal(cast.length, 4);
  assert.ok(cast.every(row => !("choice" in row.details)));
});

test("eligibility rules: excluded participants, entitlement, joined-before-open, consent and feature gate", async () => {
  const ctx = await setup();
  const now = new Date();
  const window = await openWindow(ctx, {}, now);
  const option = window.options[0]!.id;
  await grantRole(ctx.members[0]!, "performer", { organizationId: ctx.org, competitionId: ctx.competition });
  await grantRole(ctx.members[1]!, "judge", { organizationId: ctx.org, competitionId: ctx.competition });
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { optionId: option }, key(), now), code("voter_not_eligible"));
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[1]!), { optionId: option }, key(), now), code("voter_not_eligible"));

  const noConsent = await createAccount(ctx.org);
  accounts.push(noConsent);
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(noConsent), { optionId: option }, key(), now), code("consent_required"));

  const entitledWindow = await openWindow(ctx, { eligibility: "entitled" }, now);
  const entitledOption = entitledWindow.options[0]!.id;
  await assert.rejects(castBallot(ctx.org, ctx.competition, entitledWindow.id, voter(ctx.members[2]!), { optionId: entitledOption }, key(), now), code("voter_not_eligible"));
  await getSqlClient()`
    INSERT INTO entitlement_grants (organization_id, account_id, event_id, capability, source, status, starts_at)
    VALUES (${ctx.org}, ${ctx.members[2]!}, ${ctx.competition}, 'event.view', 'ticket', 'active', 0)
  `;
  await castBallot(ctx.org, ctx.competition, entitledWindow.id, voter(ctx.members[2]!), { optionId: entitledOption }, key(), now);

  const tenureWindow = await createVoteWindow(ctx.org, ctx.competition, ctx.producer, {
    label: "Tenure", eligibility: "joined_before_open",
    opensAt: new Date(now.getTime() - 60_000).toISOString(), closesAt: new Date(now.getTime() + 60_000).toISOString(),
    options: ctx.entries.map(entry => ({ entryId: entry.entryId, label: "x" + entry.entryId.slice(0, 4) }))
  });
  await transitionVoteWindow(ctx.org, ctx.competition, tenureWindow.id, ctx.producer, "publish", 1, now);
  // Members were created moments ago, after the window opened a minute "earlier".
  await getSqlClient()`UPDATE organization_memberships SET created_at = ${new Date(now.getTime() - 3_600_000)} WHERE organization_id = ${ctx.org} AND account_id = ${ctx.members[3]!}`;
  await castBallot(ctx.org, ctx.competition, tenureWindow.id, voter(ctx.members[3]!), { optionId: tenureWindow.options[0]!.id }, key(), now);
  await assert.rejects(castBallot(ctx.org, ctx.competition, tenureWindow.id, voter(ctx.members[4]!), { optionId: tenureWindow.options[0]!.id }, key(), now), code("voter_not_eligible"));

  await getSqlClient()`
    INSERT INTO feature_flags (scope_key, feature, scope, organization_id, event_id, enabled, revision, updated_by_account_id)
    VALUES (${`event:${ctx.competition}`}, 'voting', 'event', ${ctx.org}, ${ctx.competition}, false, 1, ${ctx.producer})
  `;
  await assert.rejects(castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[5]!), { optionId: option }, key(), now), code("feature_disabled"));
});

test("vote changes, verified weighting and ranked-choice tallies", async () => {
  const ctx = await setup();
  const now = new Date();
  await getSqlClient()`
    INSERT INTO account_identities (account_id, provider, issuer, subject, verified_at)
    VALUES (${ctx.members[0]!}, 'oidc', 'https://issuer.example', ${randomUUID()}, now())
  `;
  const window = await openWindow(ctx, { ballotType: "ranked", tallyMethod: "irv", allowChange: true, weighting: "verified", verifiedWeight: 3, resultVisibility: "live" }, now);
  const [a, b, c] = window.options.map(option => option.id);
  const first = await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { ranking: [a, b] }, key(), now);
  assert.equal(first.weight, 3);
  const changed = await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { ranking: [c, b] }, key(), now);
  assert.notEqual(changed.receipt, first.receipt);
  await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[1]!), { ranking: [a, b] }, key(), now);
  await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[2]!), { ranking: [b, a] }, key(), now);
  await castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[3]!), { ranking: [a] }, key(), now);
  const results = await getVoteResults(ctx.org, ctx.competition, window.id, { isManager: false, now });
  assert.ok(results.visible);
  assert.equal(results.tally.ballotCount, 4);
  assert.equal(results.tally.totalWeight, 6);
  // Round 1: a2 b1 c3 (total 6, no majority) -> b out, transfers to a -> a3 c3 tie.
  assert.deepEqual(results.tally.winners.sort(), [a!, c!].sort());
  const statuses = await getSqlClient()<{ status: string }[]>`SELECT status FROM vote_ballots WHERE window_id = ${window.id} AND account_id = ${ctx.members[0]!} ORDER BY created_at, status`;
  assert.deepEqual(statuses.map(row => row.status).sort(), ["active", "superseded"]);
  const mine = await getVoteWindow(ctx.org, ctx.competition, window.id, { isManager: false, accountId: ctx.members[0]!, now });
  assert.equal(mine.myBallot?.receipt, changed.receipt);
});

test("concurrent ballots: one per account, identical retries collapse, close is atomic", async () => {
  const ctx = await setup();
  const now = new Date();
  const window = await openWindow(ctx, {}, now);
  const option = window.options[0]!.id;
  const distinct = await Promise.allSettled(Array.from({ length: 8 }, () =>
    castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[0]!), { optionId: option }, key(), now)));
  assert.equal(distinct.filter(result => result.status === "fulfilled").length, 1);
  const sameKey = key();
  const retries = await Promise.all(Array.from({ length: 5 }, () =>
    castBallot(ctx.org, ctx.competition, window.id, voter(ctx.members[1]!), { optionId: option }, sameKey, now)));
  assert.equal(new Set(retries.map(result => result.receipt)).size, 1);

  const racing = ctx.members.slice(2).map(member =>
    castBallot(ctx.org, ctx.competition, window.id, voter(member), { optionId: option }, key(), now).then(() => "ok", (error: DomainError) => error.code));
  const close = closeVoteWindow(ctx.org, ctx.competition, window.id, ctx.producer, now);
  const outcomes = await Promise.all(racing);
  const { snapshot } = await close;
  const accepted = outcomes.filter(outcome => outcome === "ok").length;
  assert.ok(outcomes.every(outcome => outcome === "ok" || outcome === "invalid_state_window_not_open"));
  assert.equal(snapshot.ballotCount, 2 + accepted);
  const [{ count }] = (await getSqlClient()<{ count: number }[]>`SELECT count(*)::int AS count FROM vote_ballots WHERE window_id = ${window.id} AND status = 'active'`) as unknown as [{ count: number }];
  assert.equal(count, snapshot.ballotCount);
});

test("cross-tenant access to windows and ballots fails", async () => {
  const a = await setup();
  const b = await setup();
  const now = new Date();
  const window = await openWindow(a, {}, now);
  await assert.rejects(getVoteWindow(b.org, a.competition, window.id, { isManager: true }), code("competition_not_found"));
  await assert.rejects(getVoteWindow(b.org, b.competition, window.id, { isManager: true }), code("vote_window_not_found"));
  await assert.rejects(castBallot(a.org, a.competition, window.id, voter(b.members[0]!), { optionId: window.options[0]!.id }, key(), now), code("forbidden"));
  await assert.rejects(closeVoteWindow(b.org, b.competition, window.id, b.producer, now), code("vote_window_not_found"));
  await assert.rejects(createVoteWindow(b.org, b.competition, b.producer, {
    label: "Steal", opensAt: now.toISOString(), closesAt: new Date(now.getTime() + 1000).toISOString(),
    options: a.entries.slice(0, 2).map(entry => ({ entryId: entry.entryId, label: entry.entryId }))
  }), code("entry_not_found"));
  assert.equal((await listVoteWindows(b.org, b.competition, { isManager: true })).length, 0);
});

test("drafts are hidden from members and lifecycle transitions are revision-guarded", async () => {
  const ctx = await setup();
  const now = new Date();
  const draft = await createVoteWindow(ctx.org, ctx.competition, ctx.producer, {
    label: "Draft", opensAt: new Date(now.getTime() + 60_000).toISOString(), closesAt: new Date(now.getTime() + 120_000).toISOString(),
    options: ctx.entries.map(entry => ({ entryId: entry.entryId, label: entry.entryId }))
  });
  await assert.rejects(getVoteWindow(ctx.org, ctx.competition, draft.id, { isManager: false }), code("vote_window_not_found"));
  await assert.rejects(castBallot(ctx.org, ctx.competition, draft.id, voter(ctx.members[0]!), { optionId: draft.options[0]!.id }, key(), now), code("vote_window_not_found"));
  await assert.rejects(transitionVoteWindow(ctx.org, ctx.competition, draft.id, ctx.producer, "publish", 9, now), code("revision_conflict"));
  const published = await transitionVoteWindow(ctx.org, ctx.competition, draft.id, ctx.producer, "publish", 1, now);
  assert.equal(published.phase, "scheduled");
  await assert.rejects(castBallot(ctx.org, ctx.competition, draft.id, voter(ctx.members[0]!), { optionId: draft.options[0]!.id }, key(), now), code("invalid_state_window_not_open"));
  await assert.rejects(closeVoteWindow(ctx.org, ctx.competition, draft.id, ctx.producer, now), code("invalid_state_transition"));
  const cancelled = await transitionVoteWindow(ctx.org, ctx.competition, draft.id, ctx.producer, "cancel", 2, now);
  assert.equal(cancelled.status, "cancelled");
});
