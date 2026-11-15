import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createLiveShow } from "./live-fixtures.ts";
import {
  acknowledgeCue,
  getReadiness,
  listBackstageMessages,
  postCheckin,
  postCue,
  postJudgeMessage,
  setEntryAccountLink
} from "./backstage.ts";
import { getRunOfShow } from "./run-of-show.ts";
import { verifyAuditChain } from "./audit.ts";

after(closeDatabaseConnection);

const key = () => `idem-${randomUUID()}`;

async function linkedShow() {
  const show = await createLiveShow();
  await setEntryAccountLink(show.organizationId, show.competitionId, show.producer, { entryId: show.entryA.entryId, accountId: show.performerA, linked: true });
  await setEntryAccountLink(show.organizationId, show.competitionId, show.producer, { entryId: show.entryB.entryId, accountId: show.performerB, linked: true });
  return show;
}

test("enforces least-privilege visibility across performers, judges and producers", async () => {
  const s = await linkedShow();
  const producer = { accountId: s.producer, role: "producer" as const };
  const judge = { accountId: s.judge, role: "judge" as const };
  const a = { accountId: s.performerA, role: "performer" as const };
  const b = { accountId: s.performerB, role: "performer" as const };

  await postCheckin(s.organizationId, s.competitionId, a, { performanceId: s.performanceA, readiness: "need_help", note: "mic", idempotencyKey: key() });
  const cueA = await postCue(s.organizationId, s.competitionId, producer, { performanceId: s.performanceA, body: "Stand by", idempotencyKey: key() });
  await postCue(s.organizationId, s.competitionId, producer, { performanceId: s.performanceB, body: "You are next", idempotencyKey: key() });
  await postJudgeMessage(s.organizationId, s.competitionId, judge, { body: "Need a replay of the intro", idempotencyKey: key() });
  await acknowledgeCue(s.organizationId, s.competitionId, a, { cueId: cueA.id, idempotencyKey: key() });

  const feed = async (viewer: typeof a | typeof judge | typeof producer, since = 0) =>
    listBackstageMessages(s.organizationId, s.competitionId, viewer, since);
  const forA = await feed(a);
  assert.deepEqual(forA.messages.map(m => m.kind), ["checkin", "cue", "cue_ack"]);
  assert.ok(forA.messages.every(m => m.authorAccountId === undefined));
  assert.equal(forA.cursor, 5);
  const forB = await feed(b);
  assert.deepEqual(forB.messages.map(m => m.body), ["You are next"]);
  const forJudge = await feed(judge);
  assert.deepEqual(forJudge.messages.map(m => m.kind), ["judge_message"]);
  assert.equal(forJudge.messages[0]!.mine, true);
  const forProducer = await feed(producer);
  assert.equal(forProducer.messages.length, 5);
  assert.equal(forProducer.messages[0]!.authorAccountId, s.performerA);
  assert.deepEqual((await feed(producer, 3)).messages.map(m => m.seq), [4, 5]);
  assert.deepEqual((await feed(producer, 5)), { messages: [], cursor: 5, hasMore: false });

  // Role and ownership enforcement.
  await assert.rejects(postCue(s.organizationId, s.competitionId, a, { performanceId: s.performanceB, body: "fake", idempotencyKey: key() }), /forbidden/);
  await assert.rejects(postJudgeMessage(s.organizationId, s.competitionId, a, { body: "hi", idempotencyKey: key() }), /forbidden/);
  await assert.rejects(postCheckin(s.organizationId, s.competitionId, b, { performanceId: s.performanceA, readiness: "ready", idempotencyKey: key() }), /forbidden/);
  await assert.rejects(acknowledgeCue(s.organizationId, s.competitionId, b, { cueId: cueA.id, idempotencyKey: key() }), /cue_not_found/);
  await assert.rejects(acknowledgeCue(s.organizationId, s.competitionId, a, { cueId: cueA.id, idempotencyKey: key() }), /cue_already_acknowledged_conflict/);

  const readiness = await getReadiness(s.organizationId, s.competitionId);
  assert.deepEqual(readiness.map(r => [r.performanceId, r.readiness, r.note]), [[s.performanceA, "need_help", "mic"]]);
  await postCheckin(s.organizationId, s.competitionId, a, { performanceId: s.performanceA, readiness: "ready", idempotencyKey: key() });
  assert.equal((await getReadiness(s.organizationId, s.competitionId))[0]!.readiness, "ready");
  assert.equal((await verifyAuditChain(s.organizationId)).valid, true);
});

test("validates bounds, replays idempotent posts and rate-limits authors", async () => {
  const s = await linkedShow();
  const producer = { accountId: s.producer, role: "producer" as const };
  await assert.rejects(postCue(s.organizationId, s.competitionId, producer, { performanceId: s.performanceA, body: "x".repeat(281), idempotencyKey: key() }), /invalid_body/);
  await assert.rejects(postCue(s.organizationId, s.competitionId, producer, { performanceId: s.performanceA, body: "  ", idempotencyKey: key() }), /invalid_body/);
  await assert.rejects(postCheckin(s.organizationId, s.competitionId, { accountId: s.performerA, role: "performer" }, { performanceId: s.performanceA, readiness: "maybe", idempotencyKey: key() }), /invalid_readiness/);
  const idem = key();
  const first = await postCue(s.organizationId, s.competitionId, producer, { performanceId: s.performanceA, body: "Go", idempotencyKey: idem });
  const again = await postCue(s.organizationId, s.competitionId, producer, { performanceId: s.performanceA, body: "Go", idempotencyKey: idem });
  assert.equal(again.id, first.id);
  await assert.rejects(postJudgeMessage(s.organizationId, s.competitionId, producer, { body: "Go", idempotencyKey: idem }), /idempotency_conflict/);
  for (let i = 1; i < 20; i += 1) {
    await postJudgeMessage(s.organizationId, s.competitionId, producer, { body: `note ${i}`, idempotencyKey: key() });
  }
  await assert.rejects(postJudgeMessage(s.organizationId, s.competitionId, producer, { body: "one too many", idempotencyKey: key() }), /rate_limited/);
  // Regression: chains longer than 9 events must stay valid (audit ordering was textual).
  assert.equal((await verifyAuditChain(s.organizationId)).valid, true);
});

test("assigns gap-free per-competition sequences under concurrent posts", async () => {
  const s = await linkedShow();
  const authors = [s.producer, s.judge];
  await Promise.all(Array.from({ length: 16 }, (_, i) => postJudgeMessage(s.organizationId, s.competitionId,
    { accountId: authors[i % 2]!, role: i % 2 === 0 ? "producer" : "judge" }, { body: `m${i}`, idempotencyKey: key() })));
  const { messages, cursor } = await listBackstageMessages(s.organizationId, s.competitionId, { accountId: s.producer, role: "producer" }, 0);
  assert.deepEqual(messages.map(m => m.seq), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.equal(cursor, 16);
});

test("rejects cross-tenant backstage access", async () => {
  const a = await linkedShow();
  const b = await linkedShow();
  const producerB = { accountId: b.producer, role: "producer" as const };
  await assert.rejects(postCue(b.organizationId, a.competitionId, producerB, { performanceId: a.performanceA, body: "x", idempotencyKey: key() }), /competition_not_found/);
  await assert.rejects(postCue(b.organizationId, b.competitionId, producerB, { performanceId: a.performanceA, body: "x", idempotencyKey: key() }), /performance_not_found/);
  await assert.rejects(listBackstageMessages(b.organizationId, a.competitionId, producerB, 0), /competition_not_found/);
  await assert.rejects(setEntryAccountLink(b.organizationId, b.competitionId, b.producer, { entryId: a.entryA.entryId, accountId: b.performerA, linked: true }), /entry_not_found/);
  await assert.rejects(setEntryAccountLink(a.organizationId, a.competitionId, a.producer, { entryId: a.entryA.entryId, accountId: b.performerA, linked: true }), /account_not_found/);
  // Raw SQL cannot attach a message to another tenant's performance either.
  await assert.rejects(getSqlClient()`INSERT INTO backstage_messages (organization_id, competition_id, seq, kind, performance_id, readiness, author_account_id, author_role, idempotency_key)
    VALUES (${b.organizationId}, ${b.competitionId}, 999, 'checkin', ${a.performanceA}, 'ready', ${b.performerA}, 'performer', ${key()})`, /foreign key/);
  assert.deepEqual(await getRunOfShow(b.organizationId, a.competitionId), []);
});

test("run-of-show exposes only public lineup fields", async () => {
  const s = await linkedShow();
  const rounds = await getRunOfShow(s.organizationId, s.competitionId);
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0]!.performances.map(p => p.displayName), ["Entrant A", "Entrant B"]);
  assert.deepEqual(Object.keys(rounds[0]!.performances[0]!).sort(), ["displayName", "id", "ordinal", "status"]);
});
