import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { parseServerEnv } from "@live-competition-engine/config";
import { closeDatabaseConnection } from "./index.ts";
import { createEvent, setEventConfig, transitionEvent } from "./events.ts";
import { createStage, listEntrants, setStageEntrants } from "./stages.ts";
import {
  applicationHistory, decideApplication, getOwnApplication, listApplications, listLineup, promoteFromWaitlist,
  reviseApplication, setLineup, submitApplication, withdrawApplication
} from "./registration.ts";
import { seedTenants } from "./test-fixtures.ts";

const consent = { accepted: true, version: "v1" } as const;

test("applications: deadlines, consent, review, selection, waitlist promotion, versioned decisions and lineup", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  try {
    const t = await seedTenants(sql);
    const applicants = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of applicants) await sql`INSERT INTO accounts (id, email) VALUES (${id}, ${`app-${id}@example.test`})`;
    const event = await createEvent(t.orgA, t.operatorA, { title: "Open Call", startsAt: "2026-12-01T19:00:00Z", remote: true });
    await setEventConfig(t.orgA, event.id, t.operatorA, 1, { eligibility: { maxEntrants: 1 }, registration: { closesAt: "2026-11-30T00:00:00Z" } });
    const now = new Date("2026-11-20T00:00:00Z");
    await assert.rejects(submitApplication(t.orgA, event.id, applicants[0]!, { displayName: "A", consent }, now), /registration_not_open/);
    await transitionEvent(t.orgA, event.id, t.operatorA, "published", 2);

    await assert.rejects(submitApplication(t.orgA, event.id, applicants[0]!, { displayName: "A", consent: { accepted: true, version: "v0" } }, now), /consent_version_mismatch/);
    await assert.rejects(submitApplication(t.orgA, event.id, applicants[0]!, { displayName: "A", consent, mediaIds: [randomUUID()] }, now), /media_not_owned/);
    await assert.rejects(submitApplication(t.orgA, event.id, applicants[0]!, { displayName: "Late", consent }, new Date("2026-11-30T00:00:00Z")), /registration_closed/);
    await assert.rejects(submitApplication(t.orgB, event.id, applicants[0]!, { displayName: "A", consent }, now), /event_not_found/);
    const a = await submitApplication(t.orgA, event.id, applicants[0]!, { displayName: "Applicant A", statement: "Hello", consent }, now);
    const b = await submitApplication(t.orgA, event.id, applicants[1]!, { displayName: "Applicant B", consent }, now);
    const c = await submitApplication(t.orgA, event.id, applicants[2]!, { displayName: "Applicant C", consent }, now);
    await assert.rejects(submitApplication(t.orgA, event.id, applicants[0]!, { displayName: "Again", consent }, now), /already_applied/);

    await assert.rejects(reviseApplication(t.orgA, event.id, applicants[1]!, a.id, 1, { displayName: "Hijack", consent }, now), /application_not_found/);
    const revised = await reviseApplication(t.orgA, event.id, applicants[0]!, a.id, 1, { displayName: "Applicant A (revised)", consent }, now);
    assert.equal(revised.revision, 2);

    // Two producers deciding the same revision: exactly one decision lands.
    const race = await Promise.allSettled([
      decideApplication(t.orgA, event.id, t.operatorA, a.id, "selected", 2),
      decideApplication(t.orgA, event.id, t.operatorA, a.id, "rejected", 2)
    ]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    const current = await getOwnApplication(t.orgA, event.id, applicants[0]!);
    if (current!.status !== "selected") await decideApplication(t.orgA, event.id, t.operatorA, a.id, "under_review", current!.revision, "Second look");
    const selectedA = (await getOwnApplication(t.orgA, event.id, applicants[0]!))!.status === "selected"
      ? (await getOwnApplication(t.orgA, event.id, applicants[0]!))!
      : await decideApplication(t.orgA, event.id, t.operatorA, a.id, "selected", (await getOwnApplication(t.orgA, event.id, applicants[0]!))!.revision);
    assert.ok(selectedA.entryId);
    assert.equal((await listEntrants(t.orgA, event.id))[0]!.accountId, applicants[0]);

    // Capacity of one: selecting B fails, so B and C are waitlisted in order.
    await assert.rejects(decideApplication(t.orgA, event.id, t.operatorA, b.id, "selected", 1), /event_full/);
    const wb = await decideApplication(t.orgA, event.id, t.operatorA, b.id, "waitlisted", 1);
    const wc = await decideApplication(t.orgA, event.id, t.operatorA, c.id, "waitlisted", 1);
    assert.deepEqual([wb.waitlistPosition, wc.waitlistPosition], [1, 2]);
    await assert.rejects(decideApplication(t.orgA, event.id, t.operatorA, a.id, "rejected", selectedA.revision), /decision_reason_required/);

    await withdrawApplication(t.orgA, event.id, applicants[0]!, a.id);
    const promoted = await promoteFromWaitlist(t.orgA, event.id, t.operatorA);
    assert.equal(promoted?.id, b.id);
    assert.equal(promoted?.status, "selected");
    assert.deepEqual((await listApplications(t.orgA, event.id, "waitlisted")).map(x => x.id), [c.id]);
    const history = await applicationHistory(t.orgA, b.id);
    assert.deepEqual(history.map(h => h.to_status), ["submitted", "waitlisted", "selected"]);
    await assert.rejects(sql`DELETE FROM application_decisions WHERE application_id = ${b.id}`, /append-only/);
    assert.equal((await listApplications(t.orgB, event.id)).length, 0);

    const stage = await createStage(t.orgA, event.id, t.operatorA, { label: "Showcase" });
    await assert.rejects(setLineup(t.orgA, event.id, stage.id, t.operatorA, [selectedA.entryId]), /entry_not_eligible/);
    await setStageEntrants(t.orgA, event.id, stage.id, t.operatorA, [promoted!.entryId]);
    assert.equal(await setLineup(t.orgA, event.id, stage.id, t.operatorA, [promoted!.entryId]), 1);
    assert.deepEqual((await listLineup(t.orgA, event.id, stage.id)).map(s => [s.ordinal, s.displayName]), [[1, "Applicant B"]]);
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
