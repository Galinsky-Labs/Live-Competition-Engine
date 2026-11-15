import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { listAuditEvents } from "./audit.ts";
import { createAccount, createCompetition, createTenant } from "./test-fixtures.ts";
import {
  applyTemplateVersion,
  createContestTemplate,
  getAppliedTemplate,
  getContestTemplate,
  listContestTemplates,
  publishContestTemplateDraft,
  saveContestTemplateDraft
} from "./contest-templates.ts";

after(closeDatabaseConnection);

const config = (panelMax = 5) => ({
  format: { participation: "individual", matchup: "none" },
  eligibility: { requiresApplication: false, maxEntriesPerParticipant: 1, customRules: [] },
  scoring: { configRef: "rubric.v1", scaleMin: 0, scaleMax: 10, precision: 1, aggregation: "mean" },
  judging: { mode: "panel", panelSize: { min: 3, max: panelMax }, blind: true },
  duration: { performanceSeconds: { min: 0, max: 240 }, overtimePolicy: "penalize" },
  phases: [{ key: "final", label: "Final", kind: "final", timed: false }]
});

test("draft -> publish -> new draft; published versions stay immutable", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const template = await createContestTemplate(org, actor, { name: `Format ${randomUUID()}`, config: config() });
  assert.equal(template.versions[0]?.status, "draft");

  const saved = await saveContestTemplateDraft(org, template.id, actor, config(6), 1);
  assert.equal(saved.revision, 2);
  await assert.rejects(saveContestTemplateDraft(org, template.id, actor, config(7), 1), { code: "contest_template_revision_conflict" });
  await assert.rejects(publishContestTemplateDraft(org, template.id, actor, 1), { code: "contest_template_revision_conflict" });
  const v1 = await publishContestTemplateDraft(org, template.id, actor, 2);
  assert.equal(v1.status, "published");
  await assert.rejects(publishContestTemplateDraft(org, template.id, actor, 2), { code: "contest_template_draft_not_found" });

  // Editing after publication opens version 2; version 1 is untouched.
  await assert.rejects(saveContestTemplateDraft(org, template.id, actor, config(8), 2), { code: "contest_template_revision_conflict" });
  const v2 = await saveContestTemplateDraft(org, template.id, actor, config(8), null);
  assert.equal(v2.version, 2);
  const reread = await getContestTemplate(org, template.id);
  assert.equal(reread?.versions[0]?.config.judging.panelSize?.max, 6);
  assert.equal(reread?.versions[0]?.configHash, v1.configHash);

  // The database refuses direct mutation or deletion of a published version.
  await assert.rejects(getSqlClient()`UPDATE contest_template_versions SET config = '{}'::jsonb WHERE id = ${v1.id}`, /immutable/);
  await assert.rejects(getSqlClient()`DELETE FROM contest_template_versions WHERE id = ${v1.id}`, /immutable/);

  const audit = await listAuditEvents(org, { subjectId: template.id });
  assert.deepEqual(audit.map(row => row.action).reverse(),
    ["contest_template.created", "contest_template.draft_saved", "contest_template.version_published", "contest_template.draft_saved"]);
  const listed = await listContestTemplates(org);
  assert.equal(listed[0]?.latest_published_version, 1);
  assert.equal(listed[0]?.has_draft, true);
});

test("invalid config and duplicate names are rejected", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const name = `Dup ${randomUUID()}`;
  await assert.rejects(createContestTemplate(org, actor, { name, config: { ...config(), extra: true } }), { code: "invalid_template_config" });
  await createContestTemplate(org, actor, { name, config: config() });
  await assert.rejects(createContestTemplate(org, actor, { name: name.toUpperCase(), config: config() }), { code: "contest_template_name_conflict" });
});

test("concurrent draft saves at one revision: one wins", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const template = await createContestTemplate(org, actor, { name: `Race ${randomUUID()}`, config: config() });
  const results = await Promise.allSettled([4, 5, 6, 7].map(max => saveContestTemplateDraft(org, template.id, actor, config(max), 1)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  // Two concurrent "open new draft" calls after publication: one draft only.
  const draftRevision = (await getContestTemplate(org, template.id))!.versions[0]!.revision;
  await publishContestTemplateDraft(org, template.id, actor, draftRevision);
  const opened = await Promise.allSettled([1, 2, 3].map(() => saveContestTemplateDraft(org, template.id, actor, config(), null)));
  assert.equal(opened.filter(result => result.status === "fulfilled").length, 1);
});

test("applying a published version snapshots it onto an event that has not started", async () => {
  const org = await createTenant();
  const actor = await createAccount(org);
  const template = await createContestTemplate(org, actor, { name: `Apply ${randomUUID()}`, config: config() });
  const draftId = template.versions[0]!.id;
  const event = await createCompetition(org);
  await assert.rejects(applyTemplateVersion(org, event, actor, draftId, 1), { code: "contest_template_version_not_found" });
  const published = await publishContestTemplateDraft(org, template.id, actor, 1);

  const applied = await applyTemplateVersion(org, event, actor, published.id, 1);
  assert.equal(applied.eventRevision, 2);
  assert.equal(applied.snapshot.judging.mode, "panel");
  await assert.rejects(applyTemplateVersion(org, event, actor, published.id, 1), { code: "event_revision_conflict" });

  // A later draft never changes the event snapshot.
  await saveContestTemplateDraft(org, template.id, actor, config(9), null);
  assert.equal((await getAppliedTemplate(org, event))?.snapshot?.judging.panelSize?.max, 5);

  await getSqlClient()`UPDATE competitions SET status = 'live' WHERE id = ${event}`;
  await assert.rejects(applyTemplateVersion(org, event, actor, published.id, 2), { code: "invalid_state_event_started" });
});

test("templates and versions are tenant-isolated", async () => {
  const org = await createTenant();
  const other = await createTenant();
  const actor = await createAccount(org);
  const template = await createContestTemplate(org, actor, { name: `Iso ${randomUUID()}`, config: config() });
  const published = await publishContestTemplateDraft(org, template.id, actor, 1);
  const foreignEvent = await createCompetition(other);

  assert.equal(await getContestTemplate(other, template.id), null);
  assert.equal((await listContestTemplates(other)).length, 0);
  await assert.rejects(saveContestTemplateDraft(other, template.id, actor, config(), null), { code: "contest_template_not_found" });
  await assert.rejects(publishContestTemplateDraft(other, template.id, actor, 1), { code: "contest_template_not_found" });
  await assert.rejects(applyTemplateVersion(other, foreignEvent, actor, published.id, 1), { code: "contest_template_version_not_found" });
  await assert.rejects(applyTemplateVersion(org, foreignEvent, actor, published.id, 1), { code: "event_not_found" });
});
