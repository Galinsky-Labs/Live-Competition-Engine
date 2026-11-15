import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { parseServerEnv } from "@live-competition-engine/config";
import { closeDatabaseConnection } from "./index.ts";
import { applyTemplate, createEvent, createTemplateVersion, getEvent, getPublicEvent, listEvents, setEventConfig, transitionEvent, updateEvent } from "./events.ts";
import { seedTenants } from "./test-fixtures.ts";

test("event lifecycle: draft, revision races, publish gate, tenant isolation and audit", async () => {
  const sql = postgres(parseServerEnv().DATABASE_URL, { max: 1 });
  try {
    const t = await seedTenants(sql);
    const event = await createEvent(t.orgA, t.operatorA, { title: "Spring Showcase", timezone: "Europe/London" });
    assert.equal(event.status, "draft");
    assert.equal(await getPublicEvent(t.orgA, event.id), null, "drafts are not public");
    assert.equal(await getEvent(t.orgB, event.id), null, "other tenant cannot read");
    await assert.rejects(transitionEvent(t.orgA, event.id, t.operatorA, "published", 1), /event_not_publishable/);
    await assert.rejects(updateEvent(t.orgB, event.id, t.operatorB, 1, { title: "Hijack" }), /event_not_found/);

    const updated = await updateEvent(t.orgA, event.id, t.operatorA, 1, { startsAt: "2026-12-01T19:00:00Z", remote: true });
    assert.equal(updated.revision, 2);
    // Two editors racing on the same revision: exactly one wins.
    const race = await Promise.allSettled([
      updateEvent(t.orgA, event.id, t.operatorA, 2, { title: "Edit One" }),
      updateEvent(t.orgA, event.id, t.operatorA, 2, { title: "Edit Two" })
    ]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    assert.match(String((race.find(r => r.status === "rejected") as PromiseRejectedResult).reason), /revision_conflict/);

    const template = await createTemplateVersion(t.orgA, t.operatorA, "showcase", "Showcase", { scoring: { criteria: [{ key: "skill", label: "Skill", weight: 2 }, { key: "stage_presence", label: "Presence" }] } });
    const v2 = await createTemplateVersion(t.orgA, t.operatorA, "showcase", "Showcase", {});
    assert.deepEqual([template.version, v2.version], [1, 2]);
    await assert.rejects(createTemplateVersion(t.orgA, t.operatorA, "showcase", "Bad", { scoring: { criteria: [] } }), /invalid_config/);
    await assert.rejects(sql`UPDATE competition_templates SET name = 'x' WHERE id = ${template.id}`, /immutable/);
    await assert.rejects(applyTemplate(t.orgB, event.id, t.operatorB, 3, template.id), /event_not_found/);
    const applied = await applyTemplate(t.orgA, event.id, t.operatorA, 3, template.id);
    assert.equal(applied.templateVersion, 1);
    assert.equal((applied.config.scoring as { criteria: unknown[] }).criteria.length, 2);

    const published = await transitionEvent(t.orgA, event.id, t.operatorA, "published", 4);
    assert.ok(published.publishedAt);
    assert.ok(await getPublicEvent(t.orgA, event.id));
    await assert.rejects(setEventConfig(t.orgA, event.id, t.operatorA, 5, {}), /config_locked_after_publish/);
    await assert.rejects(transitionEvent(t.orgA, event.id, t.operatorA, "completed", 5), /invalid_transition/);
    await assert.rejects(transitionEvent(t.orgA, event.id, t.operatorA, "cancelled", 5), /cancel_reason_required/);
    const cancelled = await transitionEvent(t.orgA, event.id, t.operatorA, "cancelled", 5, "Venue unavailable");
    assert.equal(cancelled.cancelReason, "Venue unavailable");

    assert.equal((await listEvents(t.orgB, { includeDrafts: true })).length, 0);
    const audit = await sql<{ action: string }[]>`SELECT action FROM engine_audit_log WHERE subject_id = ${event.id} ORDER BY id`;
    assert.deepEqual(audit.map(a => a.action), ["event.created", "event.updated", "event.updated", "event.template_applied", "event.published", "event.cancelled"]);
  } finally {
    await sql.end();
    await closeDatabaseConnection();
  }
});
