import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createLiveShow } from "./live-fixtures.ts";
import { changeShowState, safetyStop, setRoundPublication, transitionPerformance, transitionRound } from "./control-room.ts";
import { createTimer, issueTimerCommand } from "./timers.ts";
import { clearCaption, getPublicOverlay, getPublicScoreboard, listActiveCaptions, setCaption } from "./broadcast.ts";

after(closeDatabaseConnection);

const key = () => `idem-${randomUUID()}`;

async function publicShow() {
  const s = await createLiveShow();
  await getSqlClient()`UPDATE competitions SET status = 'live', rules = ${getSqlClient().json({ broadcast: { blockedTerms: ["forbidden"] } })}
    WHERE id = ${s.competitionId}`;
  return s;
}

test("overlay exposes only public fields and advances its sequence on every change", async () => {
  const s = await publicShow();
  const o = s.organizationId, c = s.competitionId;
  const before = await getPublicOverlay(o, c);
  assert.ok(before);
  assert.equal(before.current, null);
  assert.equal(before.next?.displayName, "Entrant A");

  await changeShowState(o, c, s.producer, "start");
  await transitionRound(o, c, s.producer, s.roundId, "live");
  await transitionPerformance(o, c, s.producer, s.performanceA, "live");
  const timer = await createTimer(o, c, s.producer, { performanceId: s.performanceA, label: "Set", durationMs: 90_000 });
  await issueTimerCommand(o, timer.timerId, s.producer, { type: "start", idempotencyKey: key() });
  await setCaption(o, c, s.producer, { kind: "lower_third", text: "Entrant A", subtitle: "Round 1", idempotencyKey: key() });
  const live = await getPublicOverlay(o, c);
  assert.ok(live && live.sequence > before.sequence);
  assert.deepEqual(live.current, { displayName: "Entrant A", roundLabel: "Round 1" });
  assert.equal(live.next?.displayName, "Entrant B");
  assert.equal(live.timer?.status, "running");
  assert.equal(live.timer?.durationMs, 90_000);
  assert.ok(live.timer?.runningSince);
  assert.deepEqual(live.lowerThird, { text: "Entrant A", subtitle: "Round 1" });

  await safetyStop(o, c, s.producer, "Private medical detail");
  const stopped = await getPublicOverlay(o, c);
  assert.ok(stopped && stopped.sequence > live.sequence);
  assert.equal(stopped.show.state, "paused");
  assert.equal(stopped.timer?.status, "paused");
  const serialized = JSON.stringify(stopped);
  for (const secret of ["Private medical detail", s.entryA.entryId, s.performanceA, s.producer, timer.timerId, s.entryA.participantId]) {
    assert.ok(!serialized.includes(secret), `public overlay leaked ${secret}`);
  }
});

test("captions are moderated, replace the active one, clear idempotently and are audited", async () => {
  const s = await publicShow();
  const o = s.organizationId, c = s.competitionId;
  await assert.rejects(setCaption(o, c, s.producer, { kind: "caption", text: "visit evil.com", idempotencyKey: key() }), /caption_rejected_link/);
  await assert.rejects(setCaption(o, c, s.producer, { kind: "caption", text: "so F0RBIDDEN", idempotencyKey: key() }), /caption_rejected_blocked_term/);
  await assert.rejects(setCaption(o, c, s.producer, { kind: "caption", text: "x".repeat(121), idempotencyKey: key() }), /caption_rejected_length/);
  await assert.rejects(setCaption(o, c, s.producer, { kind: "ticker", text: "x", idempotencyKey: key() }), /invalid_caption_kind/);
  await assert.rejects(setCaption(o, c, s.producer, { kind: "caption", text: "x", subtitle: "y", idempotencyKey: key() }), /invalid_caption_subtitle/);
  const first = await setCaption(o, c, s.producer, { kind: "caption", text: "Welcome", idempotencyKey: key() });
  const idem = key();
  const second = await setCaption(o, c, s.producer, { kind: "caption", text: "Intermission", idempotencyKey: idem });
  assert.equal((await setCaption(o, c, s.producer, { kind: "caption", text: "Intermission", idempotencyKey: idem })).id, second.id);
  assert.deepEqual((await listActiveCaptions(o, c)).map(x => x.id), [second.id]);
  assert.deepEqual(await clearCaption(o, c, s.producer, first.id), { id: first.id, cleared: false });
  assert.deepEqual(await clearCaption(o, c, s.producer, second.id), { id: second.id, cleared: true });
  assert.equal((await getPublicOverlay(o, c))?.caption, null);
  const actions = await getSqlClient()<{ action: string }[]>`SELECT action FROM audit_events WHERE organization_id = ${o} AND action LIKE 'broadcast.%' ORDER BY sequence`;
  assert.deepEqual(actions.map(a => a.action), ["broadcast.caption_set", "broadcast.caption_set", "broadcast.caption_cleared"]);
  // Concurrent sets keep at most one active caption of a kind.
  await Promise.all(Array.from({ length: 6 }, (_, i) => setCaption(o, c, s.producer, { kind: "caption", text: `Msg ${i}`, idempotencyKey: key() })));
  assert.equal((await listActiveCaptions(o, c)).length, 1);
});

test("scoreboard shows only published, non-void results", async () => {
  const s = await publicShow();
  const o = s.organizationId, c = s.competitionId;
  const sql = getSqlClient();
  await sql`INSERT INTO results (organization_id, competition_id, round_id, entry_id, rank, score, status) VALUES
    (${o}, ${c}, ${s.roundId}, ${s.entryA.entryId}, 1, '9.5', 'final'),
    (${o}, ${c}, ${s.roundId}, ${s.entryB.entryId}, 2, '8.0', 'provisional')`;
  assert.deepEqual((await getPublicScoreboard(o, c))?.rounds, []);
  await setRoundPublication(o, c, s.producer, s.roundId, { published: true });
  const board = await getPublicScoreboard(o, c);
  assert.deepEqual(board?.rounds[0]?.standings, [
    { rank: 1, displayName: "Entrant A", score: "9.5", final: true },
    { rank: 2, displayName: "Entrant B", score: "8.0", final: false }
  ]);
  await sql`UPDATE results SET status = 'void' WHERE entry_id = ${s.entryB.entryId}`;
  assert.equal((await getPublicScoreboard(o, c))?.rounds[0]?.standings.length, 1);
  await setRoundPublication(o, c, s.producer, s.roundId, { published: false });
  assert.deepEqual((await getPublicScoreboard(o, c))?.rounds, []);
});

test("public projections are empty for private competitions and other tenants", async () => {
  const s = await createLiveShow(); // draft competition
  assert.equal(await getPublicOverlay(s.organizationId, s.competitionId), null);
  assert.equal(await getPublicScoreboard(s.organizationId, s.competitionId), null);
  const p = await publicShow();
  assert.equal(await getPublicOverlay(s.organizationId, p.competitionId), null);
  assert.equal(await getPublicScoreboard(s.organizationId, p.competitionId), null);
  assert.equal(await getPublicOverlay("not-a-uuid", p.competitionId), null);
  await assert.rejects(setCaption(s.organizationId, p.competitionId, s.producer, { kind: "caption", text: "x", idempotencyKey: key() }), /competition_not_found/);
  const caption = await setCaption(p.organizationId, p.competitionId, p.producer, { kind: "caption", text: "Hello", idempotencyKey: key() });
  await assert.rejects(clearCaption(s.organizationId, s.competitionId, s.producer, caption.id), /caption_not_found/);
});
