import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { AuthenticationService } from "@live-competition-engine/auth";
import { parseServerEnv } from "@live-competition-engine/config";
import { closeDatabaseConnection } from "./index.ts";
import { createPostgresAuthStore } from "./auth-store.ts";
import { createEvent, setEventConfig, transitionEvent } from "./events.ts";
import { setLineup } from "./registration.ts";
import { addEntrant, createStage, transitionStage } from "./stages.ts";
import {
  appealCritique, correctScores, declareRecusal, inviteJudge, listPanel, listSheets, removeJudge, resolveAppeal,
  respondToJudgeInvite, reviseCritique, stageStandings, submitScores, visibleCritiques, writeCritique
} from "./judging.ts";
import { seedTenants } from "./test-fixtures.ts";

test("judges, recusals, immutable scores with corrections, standings and critique visibility/appeals", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  const auth = new AuthenticationService(createPostgresAuthStore());
  try {
    const t = await seedTenants(sql);
    const j1 = randomUUID(), j2 = randomUUID(), performer = randomUUID();
    for (const id of [j1, j2, performer]) await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`${id}@example.test`})`;
    const event = await createEvent(t.orgA, t.operatorA, { title: "Judged", startsAt: "2026-12-01T19:00:00Z", remote: true });
    await setEventConfig(t.orgA, event.id, t.operatorA, 1, {
      judging: { panelSize: 2, requireAllJudges: true },
      scoring: { criteria: [{ key: "technique", label: "Technique", weight: 2 }, { key: "impact", label: "Impact" }], tieBreaks: ["highest_criterion_first", "shared_rank"] },
      critiques: { enabled: true, defaultVisibility: "contestant" }
    });
    const a = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "Alpha" });
    const b = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "Beta" });
    await sql`UPDATE participants SET account_id = ${performer} WHERE id = ${a.participantId}`;
    const stage = await createStage(t.orgA, event.id, t.operatorA, { label: "Final" });
    await setLineup(t.orgA, event.id, stage.id, t.operatorA, [a.entryId, b.entryId]);
    const [pa, pb] = await sql<{ id: string }[]>`SELECT id FROM performances WHERE round_id = ${stage.id} ORDER BY ordinal`;

    await inviteJudge(t.orgA, event.id, t.operatorA, `${j1}@example.test`, "Judge One");
    await inviteJudge(t.orgA, event.id, t.operatorA, `${j2}@example.test`, "Judge Two");
    await assert.rejects(inviteJudge(t.orgA, event.id, t.operatorA, `${j1}@example.test`, "Again"), /judge_already_on_panel/);
    await assert.rejects(inviteJudge(t.orgB, event.id, t.operatorB, `${j1}@example.test`, "X"), /event_not_found/);
    const { token: j1Token } = await auth.issueSession(j1);
    await assert.rejects(auth.authorizeAction(`Bearer ${j1Token}`, "judging.score", { organizationId: t.orgA, competitionId: event.id }), /forbidden/, "no grant before accepting");
    await respondToJudgeInvite(t.orgA, event.id, j1, true);
    await respondToJudgeInvite(t.orgA, event.id, j2, true);
    const principal = await auth.authorizeAction(`Bearer ${j1Token}`, "judging.score", { organizationId: t.orgA, competitionId: event.id });
    assert.equal(principal.role, "judge");
    const other = await createEvent(t.orgA, t.operatorA, { title: "Other" });
    await assert.rejects(auth.authorizeAction(`Bearer ${j1Token}`, "judging.score", { organizationId: t.orgA, competitionId: other.id }), /forbidden/, "grant is event-scoped");

    const panel = await listPanel(t.orgA, event.id);
    const judgeTwo = panel.find(p => p.accountId === j2)!;
    await declareRecusal(t.orgA, event.id, j2, judgeTwo.judgeId, b.entryId, "Coaches this entrant");

    await assert.rejects(submitScores(t.orgA, event.id, j1, pa!.id, { technique: 8, impact: 7 }), /stage_not_live/);
    await transitionEvent(t.orgA, event.id, t.operatorA, "published", 2);
    await transitionEvent(t.orgA, event.id, t.operatorA, "live", 3);
    await transitionStage(t.orgA, event.id, stage.id, t.operatorA, "live", 1);
    await assert.rejects(submitScores(t.orgA, event.id, j1, pa!.id, { technique: 8, impact: 7 }), /performance_not_scorable/);
    await sql`UPDATE performances SET status = 'completed' WHERE round_id = ${stage.id}`;
    await assert.rejects(submitScores(t.orgA, event.id, t.member, pa!.id, { technique: 8, impact: 7 }), /not_an_accepted_judge/);
    await assert.rejects(submitScores(t.orgA, event.id, j1, pa!.id, { technique: 11, impact: 7 }), /score_out_of_range/);
    const s1 = await submitScores(t.orgA, event.id, j1, pa!.id, { technique: 8, impact: 7 });
    const dup = await Promise.allSettled([
      submitScores(t.orgA, event.id, j1, pa!.id, { technique: 1, impact: 1 }),
      submitScores(t.orgA, event.id, j1, pa!.id, { technique: 2, impact: 2 })
    ]);
    assert.ok(dup.every(r => r.status === "rejected"), "a second original sheet is always refused");
    await submitScores(t.orgA, event.id, j2, pa!.id, { technique: 6, impact: 6 });
    await submitScores(t.orgA, event.id, j1, pb!.id, { technique: 9, impact: 9 });
    await assert.rejects(submitScores(t.orgA, event.id, j2, pb!.id, { technique: 9, impact: 9 }), /judge_recused/);
    await assert.rejects(sql`UPDATE score_sheets SET total = 100 WHERE id = ${s1.id}`, /immutable/);

    await assert.rejects(correctScores(t.orgA, event.id, j1, s1.id, { technique: 9, impact: 7 }, ""), /correction_reason_required/);
    await assert.rejects(correctScores(t.orgA, event.id, j2, s1.id, { technique: 9, impact: 7 }, "not mine"), /current_sheet_not_found/);
    const corrected = await correctScores(t.orgA, event.id, j1, s1.id, { technique: 9, impact: 7 }, "Mis-keyed technique");
    await assert.rejects(correctScores(t.orgA, event.id, j1, s1.id, { technique: 9, impact: 8 }, "again"), /current_sheet_not_found/);
    const sheets = await listSheets(t.orgA, event.id, stage.id);
    assert.equal(sheets.filter(s => s.current).length, 3);
    assert.equal(sheets.find(s => s.id === corrected.id)?.supersedesId, s1.id);

    const standings = await stageStandings(t.orgA, event.id, stage.id);
    assert.deepEqual(standings.map(s => [s.entryId, s.rank, s.complete]), [[b.entryId, 1, true], [a.entryId, 2, true]], "recused judge is not expected for Beta");

    await removeJudge(t.orgA, event.id, t.operatorA, judgeTwo.judgeId, "Conflict discovered");
    const { token: j2Token } = await auth.issueSession(j2);
    await assert.rejects(auth.authorizeAction(`Bearer ${j2Token}`, "judging.score", { organizationId: t.orgA, competitionId: event.id }), /forbidden/, "removal revokes the grant");

    const critique = await writeCritique(t.orgA, event.id, j1, pa!.id, "Strong opening; pacing dipped.", "public");
    assert.equal((await visibleCritiques(t.orgA, event.id, { accountId: null, producer: false })).length, 0, "public needs moderation approval");
    assert.equal((await visibleCritiques(t.orgA, event.id, { accountId: performer, producer: false })).length, 1, "the entrant sees it before moderation");
    assert.equal((await visibleCritiques(t.orgA, event.id, { accountId: t.member, producer: false })).length, 0);
    const approved = await reviseCritique(t.orgA, event.id, t.operatorA, "producer", critique.id, 1, { moderationStatus: "approved" });
    assert.equal((await visibleCritiques(t.orgA, event.id, { accountId: null, producer: false })).length, 1);
    await assert.rejects(reviseCritique(t.orgA, event.id, j1, "author", critique.id, approved.revision, { moderationStatus: "approved" }), /authors_cannot_moderate/);
    const appeal = await appealCritique(t.orgA, event.id, performer, critique.id, "Factually wrong about pacing");
    await assert.rejects(appealCritique(t.orgA, event.id, performer, critique.id, "again"), /appeal_already_open/);
    await assert.rejects(appealCritique(t.orgA, event.id, t.member, critique.id, "not my entry"), /critique_not_found/);
    await resolveAppeal(t.orgA, event.id, t.operatorA, appeal.id, "upheld", "Comment removed after review");
    assert.equal((await visibleCritiques(t.orgA, event.id, { accountId: null, producer: false })).length, 0);
    assert.equal((await visibleCritiques(t.orgB, event.id, { accountId: null, producer: true })).length, 0, "other tenant sees nothing");
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
