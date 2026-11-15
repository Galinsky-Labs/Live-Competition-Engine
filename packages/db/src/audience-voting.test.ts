import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { parseServerEnv } from "@live-competition-engine/config";
import { networkKey } from "@live-competition-engine/engine";
import { closeDatabaseConnection } from "./index.ts";
import { createEvent, setEventConfig, transitionEvent } from "./events.ts";
import { setFeatureFlag } from "./feature-flags.ts";
import { stageStandings } from "./judging.ts";
import { setLineup } from "./registration.ts";
import { addEntrant, createStage } from "./stages.ts";
import {
  answerPoll, auditVoteWindow, castVote, createPoll, createVoteWindow, listAudienceMessages, listPolls, moderateAudienceMessage,
  postAudienceMessage, react, reactionCounts, setVoteWindowStatus, voidVotesByNetwork, voteResults
} from "./audience-voting.ts";
import { seedTenants } from "./test-fixtures.ts";

test("audience interaction and voting: feature gates, consent, limits, privacy, chain integrity, anomalies", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  try {
    const t = await seedTenants(sql);
    const voters = Array.from({ length: 4 }, () => randomUUID());
    for (const id of voters) await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`${id}@example.test`})`;
    const event = await createEvent(t.orgA, t.operatorA, { title: "Fan Vote", startsAt: "2026-12-01T19:00:00Z", remote: true });
    await setEventConfig(t.orgA, event.id, t.operatorA, 1, { audience: { reactions: ["applause"], questions: true, reactionsPerMinute: 2 }, scoring: { judgeWeight: 0, audienceWeight: 1 } });
    const a = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "A" });
    const b = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "B" });
    const stage = await createStage(t.orgA, event.id, t.operatorA, { label: "Round" });
    await setLineup(t.orgA, event.id, stage.id, t.operatorA, [a.entryId, b.entryId]);
    await transitionEvent(t.orgA, event.id, t.operatorA, "published", 2);
    await transitionEvent(t.orgA, event.id, t.operatorA, "live", 3);

    // Reactions: bounded set, consent, per-minute rate limit.
    await assert.rejects(react(t.orgA, event.id, voters[0]!, "applause"), /audience_consent_required/);
    await react(t.orgA, event.id, voters[0]!, "applause", undefined, true);
    await assert.rejects(react(t.orgA, event.id, voters[0]!, "boo"), /reaction_not_allowed/);
    await react(t.orgA, event.id, voters[0]!, "applause");
    await assert.rejects(react(t.orgA, event.id, voters[0]!, "applause"), /rate_limited/);
    assert.deepEqual(await reactionCounts(t.orgA, event.id), { applause: 2 });

    // Chat and voting are off until the hierarchical flags enable them.
    await assert.rejects(postAudienceMessage(t.orgA, event.id, voters[0]!, "question", "Hi?"), /chat_disabled/);
    await assert.rejects(createVoteWindow(t.orgA, event.id, t.operatorA, { title: "Fan favourite", stageId: stage.id }), /voting_disabled/);
    for (const feature of ["chat", "voting"] as const) {
      await setFeatureFlag({ scope: "platform", feature, enabled: true, expectedRevision: 0, actorAccountId: t.operatorA }).catch(() => undefined);
      await setFeatureFlag({ scope: "tenant", organizationId: t.orgA, feature, enabled: true, expectedRevision: 0, actorAccountId: t.operatorA });
    }
    const q = await postAudienceMessage(t.orgA, event.id, voters[0]!, "question", "What inspired the piece?");
    assert.equal((await listAudienceMessages(t.orgA, event.id, false)).length, 0, "pending messages are not public");
    await moderateAudienceMessage(t.orgA, event.id, t.operatorA, q.id, "approved");
    const publicMessages = await listAudienceMessages(t.orgA, event.id, false);
    assert.equal(publicMessages.length, 1);
    assert.ok(!("accountId" in publicMessages[0]!), "author identity is not exposed");
    const poll = await createPoll(t.orgA, event.id, t.operatorA, "Encore?", ["Yes", "No"]);
    await answerPoll(t.orgA, event.id, voters[0]!, poll.id, 0);
    await assert.rejects(answerPoll(t.orgA, event.id, voters[0]!, poll.id, 1), /already_answered/);
    assert.deepEqual((await listPolls(t.orgA, event.id))[0]!.counts, [1, 0]);

    const w = await createVoteWindow(t.orgA, event.id, t.operatorA, { title: "Fan favourite", stageId: stage.id, visibility: "after_close", maxVotesPerIp: 2 });
    assert.deepEqual(w.options, [a.entryId, b.entryId]);
    const day = "test-day-secret";
    await assert.rejects(castVote(t.orgA, event.id, voters[0]!, w.id, a.entryId, { ip: "198.51.100.1", daySecret: day }), /voting_not_open/);
    const opened = await setVoteWindowStatus(t.orgA, event.id, t.operatorA, w.id, "open", 1);
    const r1 = await castVote(t.orgA, event.id, voters[0]!, w.id, a.entryId, { ip: "198.51.100.1", daySecret: day });
    assert.match(r1.receipt, /^[0-9a-f]{64}$/);
    await assert.rejects(castVote(t.orgA, event.id, voters[0]!, w.id, b.entryId, { ip: "198.51.100.1", daySecret: day }), /vote_limit_reached/);
    await assert.rejects(castVote(t.orgA, event.id, voters[1]!, w.id, randomUUID(), { ip: "198.51.100.2", daySecret: day }), /invalid_vote_option/);
    // Concurrent votes from the same account: one counts.
    const race = await Promise.allSettled([
      castVote(t.orgA, event.id, voters[1]!, w.id, b.entryId, { ip: "198.51.100.2", daySecret: day }),
      castVote(t.orgA, event.id, voters[1]!, w.id, a.entryId, { ip: "198.51.100.2", daySecret: day })
    ]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    await castVote(t.orgA, event.id, voters[2]!, w.id, b.entryId, { ip: "198.51.100.1", daySecret: day });
    await assert.rejects(castVote(t.orgA, event.id, voters[3]!, w.id, b.entryId, { ip: "198.51.100.1", daySecret: day }), /network_vote_limit_reached/);
    await assert.rejects(castVote(t.orgB, event.id, voters[3]!, w.id, b.entryId, { ip: null, daySecret: day }), /voting_disabled|vote_window_not_found|scope denied/);

    const stored = await sql<{ voter_hash: string }[]>`SELECT voter_hash FROM votes WHERE window_id = ${w.id}`;
    assert.ok(stored.every(v => !voters.some(id => v.voter_hash.includes(id))), "no account ids in votes");
    await assert.rejects(sql`UPDATE votes SET entry_id = ${a.entryId} WHERE window_id = ${w.id}`, /append-only/);
    assert.equal((await voteResults(t.orgA, event.id, w.id, false)).tally, null, "hidden until close");

    const net = networkKey(day, "198.51.100.1");
    const voided = await voidVotesByNetwork(t.orgA, event.id, t.operatorA, w.id, net, "Shared network flood");
    assert.equal(voided.voided, 2);
    const closed = await setVoteWindowStatus(t.orgA, event.id, t.operatorA, w.id, "closed", opened.revision);
    const results = await voteResults(t.orgA, event.id, w.id, false);
    assert.deepEqual(results.tally?.map(x => x.votes), [0, 1]);
    const audit = await auditVoteWindow(t.orgA, event.id, w.id);
    assert.deepEqual([audit.chainIntact, audit.voteCount, audit.voidCount, audit.digestMatchesClose], [true, 3, 2, true]);
    assert.equal(closed.closedDigest, audit.digest);

    const standings = await stageStandings(t.orgA, event.id, stage.id);
    assert.equal(standings[0]!.entryId, b.entryId, "audience share feeds scoring");
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
