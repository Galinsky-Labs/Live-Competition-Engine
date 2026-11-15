import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DomainError } from "@live-competition-engine/domain";
import {
  acceptAudienceTerms,
  addBlockedTerm,
  addReaction,
  createPoll,
  decideQuestion,
  getAudienceSettings,
  getPoll,
  getReactionCounts,
  listBlockedTerms,
  listChatMessages,
  listPolls,
  listQuestions,
  moderateChatMessage,
  muteAccount,
  postChatMessage,
  removeBlockedTerm,
  revokeMute,
  submitQuestion,
  transitionPoll,
  updateAudienceSettings,
  upvoteQuestion,
  votePoll
} from "./audience.ts";
import { listAuditEvents, verifyAuditChain } from "./audit.ts";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createCompetition, createTenant, enableFeature } from "./test-fixtures.ts";
import { cleanupTenants, createPerformance } from "./audience-fixtures.ts";

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

async function setup(features: string[] = ["reactions", "chat", "questions", "polls"]) {
  const org = await createTenant();
  tenants.push(org);
  const producer = await createAccount(org);
  const member = await createAccount(org);
  const second = await createAccount(org);
  accounts.push(producer, member, second);
  const competition = await createCompetition(org);
  for (const feature of features) await enableFeature(feature, org, producer);
  await updateAudienceSettings(org, competition, producer, { termsVersion: "v1" }, 0);
  return { org, producer, member, second, competition };
}

test("settings use optimistic revisions and consent must match the current terms version", async () => {
  const { org, producer, member, competition } = await setup();
  const settings = await getAudienceSettings(org, competition);
  assert.equal(settings.revision, 1);
  await assert.rejects(updateAudienceSettings(org, competition, producer, { termsVersion: "v2" }, 0), code("revision_conflict"));
  await assert.rejects(updateAudienceSettings(org, competition, producer, { termsVersion: "bad version" }, 1), code("invalid_terms_version"));
  await assert.rejects(postChatMessage(org, competition, member, "hello"), code("consent_required"));
  await assert.rejects(acceptAudienceTerms(org, competition, member, "v0"), code("terms_version_mismatch"));
  await acceptAudienceTerms(org, competition, member, "v1");
  await acceptAudienceTerms(org, competition, member, "v1"); // idempotent
  await postChatMessage(org, competition, member, "hello");
  // A new terms version requires fresh consent.
  const updated = await updateAudienceSettings(org, competition, producer, { termsVersion: "v2", slowModeSeconds: 0 }, 1);
  assert.equal(updated.revision, 2);
  await assert.rejects(postChatMessage(org, competition, member, "again"), code("consent_required"));
  const audit = await listAuditEvents(org, { subjectType: "competition", subjectId: competition });
  assert.equal(audit.filter(row => row.action === "audience.settings_updated").length, 2);
});

test("features are independently gated and fail closed", async () => {
  const { org, producer, member, competition } = await setup(["chat"]);
  // Platform defaults may be on (shared database): veto explicitly at tenant scope.
  for (const feature of ["reactions", "questions"]) {
    await getSqlClient()`
      INSERT INTO feature_flags (scope_key, feature, scope, organization_id, enabled, revision, updated_by_account_id)
      VALUES (${`tenant:${org}`}, ${feature}, 'tenant', ${org}, false, 1, ${producer})
    `;
  }
  await acceptAudienceTerms(org, competition, member, "v1");
  const { performanceId } = await createPerformance(org, competition);
  await postChatMessage(org, competition, member, "chat is on");
  await assert.rejects(addReaction(org, competition, performanceId, member, "applause"), code("feature_disabled"));
  await assert.rejects(submitQuestion(org, competition, member, "Is this on?"), code("feature_disabled"));
  const outsider = await createAccount();
  accounts.push(outsider);
  await assert.rejects(postChatMessage(org, competition, outsider, "not a member"), code("forbidden"));
});

test("reactions aggregate per performance from a fixed set with a per-account rate limit", async () => {
  const { org, member, second, competition } = await setup();
  await acceptAudienceTerms(org, competition, member, "v1");
  await acceptAudienceTerms(org, competition, second, "v1");
  const { performanceId } = await createPerformance(org, competition);
  const now = new Date(Date.now() + 3_600_000);
  await addReaction(org, competition, performanceId, member, "applause", now);
  const counts = await addReaction(org, competition, performanceId, second, "applause", now);
  assert.equal(counts.applause, 2);
  assert.equal(counts.heart, 0);
  await assert.rejects(addReaction(org, competition, performanceId, member, "boo", now), code("invalid_reaction"));
  await assert.rejects(addReaction(org, competition, randomUUID(), member, "heart", now), code("performance_not_found"));
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => addReaction(org, competition, performanceId, member, "star", now)));
  const accepted = results.filter(result => result.status === "fulfilled").length;
  assert.equal(accepted, 29); // 30 per window, one already used.
  assert.equal((await getReactionCounts(org, competition, performanceId)).star, 29);
});

test("chat enforces blocked terms, slow mode, mutes and audited moderation", async () => {
  const { org, producer, member, second, competition } = await setup();
  await acceptAudienceTerms(org, competition, member, "v1");
  await acceptAudienceTerms(org, competition, second, "v1");
  const term = await addBlockedTerm(org, producer, "Forbiddenword");
  assert.deepEqual((await listBlockedTerms(org)).map(row => row.term), ["forbiddenword"]);
  await assert.rejects(postChatMessage(org, competition, member, "a FORBIDDENWORD here"), code("message_blocked"));
  await removeBlockedTerm(org, producer, term.id);
  await postChatMessage(org, competition, member, "a forbiddenword here");

  await updateAudienceSettings(org, competition, producer, { termsVersion: "v1", slowModeSeconds: 30, chatMaxLength: 20 }, 1);
  const t0 = new Date(Date.now() + 7_200_000);
  await postChatMessage(org, competition, second, "first", t0);
  await assert.rejects(postChatMessage(org, competition, second, "too soon", new Date(t0.getTime() + 10_000)), code("rate_limited"));
  await assert.rejects(postChatMessage(org, competition, second, "x".repeat(21), new Date(t0.getTime() + 40_000)), code("invalid_message"));
  const message = await postChatMessage(org, competition, second, "later", new Date(t0.getTime() + 40_000));

  const hidden = await moderateChatMessage(org, competition, message.id, producer, "hide", "off topic");
  assert.equal(hidden.status, "hidden");
  assert.ok(!(await listChatMessages(org, competition)).some(row => row.id === message.id));
  assert.ok((await listChatMessages(org, competition, { includeModerated: true })).some(row => row.id === message.id));
  const deleted = await moderateChatMessage(org, competition, message.id, producer, "delete", "abuse");
  assert.equal(deleted.body, null);
  await assert.rejects(moderateChatMessage(org, competition, message.id, producer, "unhide", "undo"), code("invalid_state_transition"));
  await assert.rejects(moderateChatMessage(org, competition, message.id, producer, "hide", ""), code("invalid_reason"));

  const mute = await muteAccount(org, competition, second, producer, 600, "spam", t0);
  await assert.rejects(postChatMessage(org, competition, second, "muted", new Date(t0.getTime() + 120_000)), code("account_muted"));
  await postChatMessage(org, competition, second, "after", new Date(t0.getTime() + 700_000));
  await revokeMute(org, competition, mute.id, producer);

  const audit = await listAuditEvents(org, { subjectType: "chat_message", subjectId: message.id });
  assert.deepEqual(audit.map(row => row.action), ["audience.chat_moderated", "audience.chat_moderated"]);
  assert.equal((await verifyAuditChain(org)).valid, true);
});

test("cross-tenant reads and moderation fail", async () => {
  const a = await setup();
  const b = await setup();
  await acceptAudienceTerms(a.org, a.competition, a.member, "v1");
  const message = await postChatMessage(a.org, a.competition, a.member, "tenant A only");
  await assert.rejects(moderateChatMessage(b.org, a.competition, message.id, b.producer, "hide", "x"), code("competition_not_found"));
  await assert.rejects(moderateChatMessage(b.org, b.competition, message.id, b.producer, "hide", "x"), code("message_not_found"));
  await assert.rejects(listChatMessages(b.org, a.competition), code("competition_not_found"));
  // A member of tenant B cannot participate in tenant A even with A's competition id.
  await assert.rejects(postChatMessage(a.org, a.competition, b.member, "intrusion"), code("forbidden"));
  await assert.rejects(acceptAudienceTerms(b.org, a.competition, b.member, "v1"), code("competition_not_found"));
  await assert.rejects(removeBlockedTerm(b.org, b.producer, (await addBlockedTerm(a.org, a.producer, "zzz")).id), code("blocked_term_not_found"));
});

test("questions: one upvote per account under concurrency and terminal producer decisions", async () => {
  const { org, producer, member, second, competition } = await setup();
  await acceptAudienceTerms(org, competition, member, "v1");
  await acceptAudienceTerms(org, competition, second, "v1");
  const question = await submitQuestion(org, competition, member, "What inspired this?");
  const votes = await Promise.all(Array.from({ length: 8 }, () => upvoteQuestion(org, competition, question.id, second)));
  assert.equal(votes.filter(vote => vote.counted).length, 1);
  await upvoteQuestion(org, competition, question.id, member);
  assert.equal((await listQuestions(org, competition))[0]?.upvoteCount, 2);
  await decideQuestion(org, competition, question.id, producer, "answered");
  await assert.rejects(decideQuestion(org, competition, question.id, producer, "dismissed"), code("invalid_state_transition"));
  await assert.rejects(upvoteQuestion(org, competition, question.id, second), code("invalid_state_question_closed"));
  assert.equal((await listQuestions(org, competition, { status: "open" })).length, 0);
});

test("polls: lifecycle, one vote per account, scheduled close and visibility rules", async () => {
  const { org, producer, member, second, competition } = await setup();
  await acceptAudienceTerms(org, competition, member, "v1");
  await acceptAudienceTerms(org, competition, second, "v1");
  const poll = await createPoll(org, competition, producer, { question: "Best moment?", options: ["One", "Two", "Three"], resultsVisibility: "after_close" });
  assert.equal(poll.status, "draft");
  await assert.rejects(votePoll(org, competition, poll.id, member, poll.options[0]!.id), code("invalid_state_poll_not_open"));
  await assert.rejects(getPoll(org, competition, poll.id, { isManager: false }), code("poll_not_found"));
  await assert.rejects(transitionPoll(org, competition, poll.id, producer, "open", 7), code("revision_conflict"));
  await transitionPoll(org, competition, poll.id, producer, "open", 1);
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => votePoll(org, competition, poll.id, member, poll.options[1]!.id)));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  await votePoll(org, competition, poll.id, second, poll.options[0]!.id);
  await assert.rejects(votePoll(org, competition, poll.id, second, randomUUID()), code("invalid_option"));
  const memberView = await getPoll(org, competition, poll.id, { isManager: false, accountId: member });
  assert.equal(memberView.results, null);
  assert.equal(memberView.myOptionId, poll.options[1]!.id);
  assert.equal((await getPoll(org, competition, poll.id, { isManager: true })).totalVotes, 2);
  await transitionPoll(org, competition, poll.id, producer, "close", 2);
  const closed = await getPoll(org, competition, poll.id, { isManager: false });
  assert.deepEqual(closed.results?.map(row => row.votes), [1, 1, 0]);

  // Scheduled close is enforced by the server even if the producer disconnects.
  const now = new Date();
  const scheduled = await createPoll(org, competition, producer, { question: "Quick?", options: ["Yes", "No"], resultsVisibility: "live", closesAt: new Date(now.getTime() + 60_000).toISOString() }, now);
  await transitionPoll(org, competition, scheduled.id, producer, "open", 1, now);
  await assert.rejects(votePoll(org, competition, scheduled.id, member, scheduled.options[0]!.id, new Date(now.getTime() + 61_000)), code("invalid_state_poll_not_open"));
  assert.equal((await listPolls(org, competition, { isManager: false })).length, 2);
  await assert.rejects(createPoll(org, competition, producer, { question: "Q", options: ["only"] }), code("invalid_poll_options"));
  const rows = await getSqlClient()`SELECT 1 FROM audience_poll_votes WHERE organization_id = ${org}`;
  assert.equal(rows.length, 2);
});
