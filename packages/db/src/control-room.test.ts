import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { parseServerEnv } from "@live-competition-engine/config";
import { closeDatabaseConnection } from "./index.ts";
import { createEvent, getEvent, setEventConfig, transitionEvent } from "./events.ts";
import { setLineup } from "./registration.ts";
import { addEntrant, createStage, transitionStage } from "./stages.ts";
import { finishPerformance, liveSnapshot, readTimer, safetyStop, startPerformance, timerCommand, timerKey, updateLiveState } from "./control-room.ts";
import { seedTenants } from "./test-fixtures.ts";

test("control room: one live performance, server timers, safety stop and reconnect snapshot", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  try {
    const t = await seedTenants(sql);
    const event = await createEvent(t.orgA, t.operatorA, { title: "Live Show", startsAt: "2026-12-01T19:00:00Z", remote: true });
    await setEventConfig(t.orgA, event.id, t.operatorA, 1, { timing: { performanceSeconds: 120, maxExtensionSeconds: 30, overtimeGraceSeconds: 10 } });
    const a = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "First" });
    const b = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "Second" });
    const stage = await createStage(t.orgA, event.id, t.operatorA, { label: "Main", timed: true, durationSeconds: 90 });
    await setLineup(t.orgA, event.id, stage.id, t.operatorA, [a.entryId, b.entryId]);
    const [p1, p2] = await sql<{ id: string }[]>`SELECT id FROM performances WHERE round_id = ${stage.id} ORDER BY ordinal`;
    await assert.rejects(startPerformance(t.orgA, event.id, t.operatorA, p1!.id), /event_not_live/);
    await transitionEvent(t.orgA, event.id, t.operatorA, "published", 2);
    await transitionEvent(t.orgA, event.id, t.operatorA, "live", 3);
    await assert.rejects(startPerformance(t.orgA, event.id, t.operatorA, p1!.id), /stage_not_live/);
    await transitionStage(t.orgA, event.id, stage.id, t.operatorA, "live", 1);
    await assert.rejects(startPerformance(t.orgB, event.id, t.operatorB, p1!.id), /event_not_found/);

    const race = await Promise.allSettled([startPerformance(t.orgA, event.id, t.operatorA, p1!.id), startPerformance(t.orgA, event.id, t.operatorA, p2!.id)]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1, "only one performance can be live");
    const liveId = (await sql<{ id: string }[]>`SELECT id FROM performances WHERE round_id = ${stage.id} AND status = 'live'`)[0]!.id;
    const key = timerKey("performance", liveId);
    const started = await readTimer(t.orgA, (await getEvent(t.orgA, event.id))!, key);
    assert.deepEqual([started.status, started.durationMs], ["running", 90_000], "stage duration overrides the event default");

    // Two producers issue commands against the same sequence: one is refused.
    const cmds = await Promise.allSettled([
      timerCommand(t.orgA, event.id, key, t.operatorA, { type: "pause" }, 1),
      timerCommand(t.orgA, event.id, key, t.operatorA, { type: "extend", ms: 10_000 }, 1)
    ]);
    assert.equal(cmds.filter(r => r.status === "fulfilled").length, 1);
    await assert.rejects(timerCommand(t.orgA, event.id, key, t.operatorA, { type: "extend", ms: 40_000 }), /extension_limit_reached/);
    await assert.rejects(sql`DELETE FROM timer_events WHERE timer_key = ${key}`, /append-only/);

    await updateLiveState(t.orgA, event.id, t.operatorA, { caption: "Now performing: First", showScoreboard: true });
    const snap = await liveSnapshot(t.orgA, (await getEvent(t.orgA, event.id))!);
    assert.equal(snap.current?.performanceId, liveId);
    assert.ok(snap.next);
    assert.equal(snap.live.caption, "Now performing: First");
    assert.ok(Math.abs(snap.serverNow - Date.now()) < 5_000);

    const stop = await safetyStop(t.orgA, event.id, t.operatorA, "Medical emergency in row C");
    assert.equal((await getEvent(t.orgA, event.id))!.status, "paused");
    const afterStop = await readTimer(t.orgA, (await getEvent(t.orgA, event.id))!, key);
    assert.notEqual(afterStop.status, "running");
    assert.ok(stop.pausedTimers <= 1);
    const [cue] = await sql<{ body: string }[]>`SELECT body FROM backstage_messages WHERE competition_id = ${event.id} AND kind = 'cue'`;
    assert.match(cue!.body, /SAFETY STOP/);

    await transitionEvent(t.orgA, event.id, t.operatorA, "live", (await getEvent(t.orgA, event.id))!.revision);
    await finishPerformance(t.orgA, event.id, t.operatorA, liveId, "completed");
    const finished = await readTimer(t.orgA, (await getEvent(t.orgA, event.id))!, key);
    assert.equal(finished.status, "stopped");
    const queued = liveId === p1!.id ? p2!.id : p1!.id;
    await assert.rejects(finishPerformance(t.orgA, event.id, t.operatorA, queued, "skipped"), /reason_required/);
    await finishPerformance(t.orgA, event.id, t.operatorA, queued, "skipped", "Entrant unwell");
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
