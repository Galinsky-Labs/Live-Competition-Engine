import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { parseServerEnv } from "@live-competition-engine/config";
import { closeDatabaseConnection } from "./index.ts";
import { createEvent, transitionEvent } from "./events.ts";
import {
  addEntrant, advanceStage, createStage, decideMatchup, generateBracket, listEntrants, listMatchups, listStageEntrants,
  setEntrantStatus, setStageEntrants, transitionStage, updateStage
} from "./stages.ts";
import { seedTenants } from "./test-fixtures.ts";

test("stages, advancement contracts and seeded brackets with corrections", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  try {
    const t = await seedTenants(sql);
    const event = await createEvent(t.orgA, t.operatorA, { title: "Bracket Night", startsAt: "2026-12-01T19:00:00Z", remote: true });
    const names = ["One", "Two", "Three", "Four", "Five"];
    const entrants = [];
    for (const name of names) entrants.push(await addEntrant(t.orgA, event.id, t.operatorA, { displayName: name }));
    const crew = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "Crew", kind: "group", members: ["M1", "M2"] });
    assert.deepEqual((await listEntrants(t.orgA, event.id)).find(e => e.entryId === crew.entryId)?.members, ["M1", "M2"]);
    await assert.rejects(addEntrant(t.orgB, event.id, t.operatorB, { displayName: "Intruder" }), /event_not_found/);
    await setEntrantStatus(t.orgA, event.id, crew.entryId, t.operatorA, "withdrawn", null);

    const heat = await createStage(t.orgA, event.id, t.operatorA, { label: "Heat", kind: "heat", advancement: { type: "top_n", count: 4 } });
    const bracket = await createStage(t.orgA, event.id, t.operatorA, { label: "Knockout", kind: "final", format: "head_to_head", advancement: { type: "bracket_winners" } });
    assert.deepEqual([heat.ordinal, bracket.ordinal], [1, 2]);
    await assert.rejects(updateStage(t.orgA, event.id, heat.id, t.operatorA, 9, { label: "x" }), /revision_conflict/);
    await setStageEntrants(t.orgA, event.id, heat.id, t.operatorA, entrants.map(e => e.entryId));
    await assert.rejects(setStageEntrants(t.orgA, event.id, heat.id, t.operatorA, [crew.entryId]), /entry_not_eligible/);
    await assert.rejects(transitionStage(t.orgA, event.id, heat.id, t.operatorA, "live", 1), /event_not_live/);

    await transitionEvent(t.orgA, event.id, t.operatorA, "published", 1);
    await transitionEvent(t.orgA, event.id, t.operatorA, "live", 2);
    await transitionStage(t.orgA, event.id, heat.id, t.operatorA, "live", 1);
    await assert.rejects(transitionStage(t.orgA, event.id, bracket.id, t.operatorA, "live", 1), /another_stage_live/);
    await assert.rejects(advanceStage(t.orgA, event.id, heat.id, bracket.id, t.operatorA, []), /source_stage_not_completed/);
    await transitionStage(t.orgA, event.id, heat.id, t.operatorA, "completed", 2);

    const standings = entrants.map((e, i) => ({ entryId: e.entryId, score: 10 - i, rank: i + 1 }));
    const advancing = await advanceStage(t.orgA, event.id, heat.id, bracket.id, t.operatorA, standings);
    assert.deepEqual(advancing, entrants.slice(0, 4).map(e => e.entryId));
    assert.equal((await listStageEntrants(t.orgA, event.id, heat.id)).filter(e => e.status === "eliminated").length, 1);
    await assert.rejects(advanceStage(t.orgA, event.id, heat.id, bracket.id, t.operatorA, standings), /target_stage_already_seeded/);

    const matchups = await generateBracket(t.orgA, event.id, bracket.id, t.operatorA);
    await assert.rejects(generateBracket(t.orgA, event.id, bracket.id, t.operatorA), /bracket_already_generated/);
    assert.equal(matchups.length, 3);
    const [semi1, semi2] = matchups.filter(m => m.bracketRound === 1);
    assert.deepEqual([semi1!.seedA, semi1!.seedB, semi2!.seedA, semi2!.seedB], [1, 4, 2, 3]);
    await assert.rejects(decideMatchup(t.orgA, event.id, semi1!.id, t.operatorA, semi1!.entryAId, 1), /stage_not_live/);
    await transitionStage(t.orgA, event.id, bracket.id, t.operatorA, "live", 1);
    await assert.rejects(decideMatchup(t.orgA, event.id, semi1!.id, t.operatorA, entrants[4]!.entryId, 1), /winner_not_in_matchup/);
    const d1 = await decideMatchup(t.orgA, event.id, semi1!.id, t.operatorA, semi1!.entryBId, 1);
    // Correction before the final is decided must give a reason.
    await assert.rejects(decideMatchup(t.orgA, event.id, semi1!.id, t.operatorA, semi1!.entryAId, d1.revision), /correction_reason_required/);
    await decideMatchup(t.orgA, event.id, semi1!.id, t.operatorA, semi1!.entryAId, d1.revision, "Scoring sheet transcription error");
    await decideMatchup(t.orgA, event.id, semi2!.id, t.operatorA, semi2!.entryAId, 1);
    const final = (await listMatchups(t.orgA, event.id, bracket.id)).find(m => m.bracketRound === 2)!;
    assert.deepEqual([final.entryAId, final.entryBId, final.status], [semi1!.entryAId, semi2!.entryAId, "ready"]);
    // Concurrent decisions on the same revision: one wins.
    const race = await Promise.allSettled([
      decideMatchup(t.orgA, event.id, final.id, t.operatorA, final.entryAId, final.revision),
      decideMatchup(t.orgA, event.id, final.id, t.operatorA, final.entryBId, final.revision)
    ]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    const latest = (await listMatchups(t.orgA, event.id, bracket.id)).find(m => m.id === semi1!.id)!;
    await assert.rejects(decideMatchup(t.orgA, event.id, semi1!.id, t.operatorA, semi1!.entryBId, latest.revision, "late change"), /downstream_matchup_already_decided/);
    const active = (await listStageEntrants(t.orgA, event.id, bracket.id)).filter(e => e.status === "active");
    assert.equal(active.length, 1, "only the champion remains active");
    assert.equal((await listMatchups(t.orgB, event.id, bracket.id)).length, 0, "other tenants see nothing");
    const audit = await sql<{ action: string }[]>`SELECT action FROM engine_audit_log WHERE action LIKE 'matchup.%' AND details->>'winner' IS NOT NULL AND subject_id = ${semi1!.id} ORDER BY id`;
    assert.deepEqual(audit.map(a => a.action), ["matchup.decided", "matchup.corrected"]);
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
