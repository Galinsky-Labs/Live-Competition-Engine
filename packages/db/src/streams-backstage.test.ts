import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { parseServerEnv } from "@live-competition-engine/config";
import { selectStreamingProvider } from "@live-competition-engine/engine";
import { closeDatabaseConnection } from "./index.ts";
import { createEvent } from "./events.ts";
import { inviteJudge, respondToJudgeInvite } from "./judging.ts";
import { addEntrant } from "./stages.ts";
import { backstageRole, configureStream, getStream, listBackstage, listReadiness, postBackstage, setReadiness, setStreamStatus } from "./streams-backstage.ts";
import { seedTenants } from "./test-fixtures.ts";

test("stream lifecycle with failure recovery; least-privilege backstage", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  try {
    const t = await seedTenants(sql);
    const event = await createEvent(t.orgA, t.operatorA, { title: "Streamed", remote: true });
    await assert.rejects(configureStream(t.orgA, event.id, t.operatorA, selectStreamingProvider({}), null), /streaming_disabled/);
    const embed = selectStreamingProvider({ STREAMING_PROVIDER: "external_embed" });
    await assert.rejects(configureStream(t.orgA, event.id, t.operatorA, embed, "https://evil.example/x"), /embed_host_not_allowed/);
    await assert.rejects(configureStream(t.orgB, event.id, t.operatorB, embed, "https://www.youtube.com/embed/x"), /event_not_found/);
    const { stream, streamKey } = await configureStream(t.orgA, event.id, t.operatorA, embed, "https://www.youtube.com/embed/x");
    assert.equal(streamKey, null);
    assert.equal(stream.status, "idle");
    const live = await setStreamStatus(t.orgA, event.id, t.operatorA, "live", 1);
    await assert.rejects(setStreamStatus(t.orgA, event.id, t.operatorA, "failed", live.revision), /failure_reason_required/);
    const failed = await setStreamStatus(t.orgA, event.id, t.operatorA, "failed", live.revision, "Encoder disconnected");
    await assert.rejects(configureStream(t.orgA, event.id, t.operatorA, embed, "https://www.youtube.com/embed/y").then(() => setStreamStatus(t.orgA, event.id, t.operatorA, "live", failed.revision)), /revision_conflict/);
    const current = (await getStream(t.orgA, event.id))!;
    const recovered = await setStreamStatus(t.orgA, event.id, t.operatorA, "live", current.revision);
    assert.equal(recovered.failureReason, null);
    await setStreamStatus(t.orgA, event.id, t.operatorA, "ended", recovered.revision, undefined, "https://www.youtube.com/watch?v=x");
    assert.equal((await getStream(t.orgB, event.id)), null);

    const judgeAcct = randomUUID(), performerAcct = randomUUID();
    for (const id of [judgeAcct, performerAcct]) await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`${id}@example.test`})`;
    await inviteJudge(t.orgA, event.id, t.operatorA, `${judgeAcct}@example.test`, "J");
    await respondToJudgeInvite(t.orgA, event.id, judgeAcct, true);
    const entry = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "Performer" });
    const other = await addEntrant(t.orgA, event.id, t.operatorA, { displayName: "Other" });
    await sql`UPDATE participants SET account_id = ${performerAcct} WHERE id = ${entry.participantId}`;

    const producer = (await backstageRole(t.orgA, event.id, t.operatorA, true))!;
    const judge = (await backstageRole(t.orgA, event.id, judgeAcct, false))!;
    const performer = (await backstageRole(t.orgA, event.id, performerAcct, false))!;
    assert.equal(await backstageRole(t.orgA, event.id, t.member, false), null, "plain members have no backstage access");
    assert.deepEqual([judge.role, performer.role], ["judge", "performer"]);

    await postBackstage(t.orgA, event.id, t.operatorA, producer, { audience: "judges", body: "Scores due in 2 minutes" });
    await postBackstage(t.orgA, event.id, t.operatorA, producer, { audience: "performers", body: "Performer one to the wings", kind: "cue", entryId: entry.entryId });
    await postBackstage(t.orgA, event.id, performerAcct, performer, { body: "Mic battery low" });
    await assert.rejects(postBackstage(t.orgA, event.id, performerAcct, performer, { audience: "judges", body: "Please vote for me" }), /audience_not_allowed/);
    await assert.rejects(postBackstage(t.orgA, event.id, judgeAcct, judge, { audience: "judges", body: "x", kind: "cue" }), /only_producers_cue/);
    assert.deepEqual((await listBackstage(t.orgA, event.id, judge)).map(m => m.body), ["Scores due in 2 minutes"]);
    assert.deepEqual((await listBackstage(t.orgA, event.id, performer)).map(m => m.body), ["Performer one to the wings"]);
    assert.equal((await listBackstage(t.orgA, event.id, producer)).length, 3);

    await setReadiness(t.orgA, event.id, performerAcct, performer, entry.entryId, "technical_issue", "Mic");
    await assert.rejects(setReadiness(t.orgA, event.id, performerAcct, performer, other.entryId, "ready"), /forbidden/);
    await assert.rejects(setReadiness(t.orgA, event.id, judgeAcct, judge, entry.entryId, "ready"), /forbidden/);
    await setReadiness(t.orgA, event.id, t.operatorA, producer, other.entryId, "ready");
    assert.equal((await listReadiness(t.orgA, event.id, performer)).length, 1);
    assert.equal((await listReadiness(t.orgA, event.id, producer)).length, 2);
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
