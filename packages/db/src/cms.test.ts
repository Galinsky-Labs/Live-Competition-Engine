import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDatabaseConnection, getSqlClient } from "./index.ts";
import { createAccount, createTenant, enableFeature } from "./test-fixtures.ts";
import { listAuditEvents } from "./audit.ts";
import { takeModerationAction } from "./moderation.ts";
import {
  cancelScheduledPublish,
  createPage,
  getPageForEditing,
  getPublishedPage,
  listNavigation,
  publishPage,
  rollbackPage,
  runDueScheduledPublications,
  schedulePublish,
  setNavigation,
  updateDraft
} from "./cms.ts";

after(closeDatabaseConnection);

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return "no_error";
};

async function cmsTenant() {
  const org = await createTenant();
  const operator = await createAccount(org);
  await enableFeature("cms", org, operator);
  return { org, operator };
}

test("cms writes are refused while the feature is disabled", async () => {
  const org = await createTenant();
  const operator = await createAccount(org);
  await getSqlClient()`
    INSERT INTO feature_flags (scope_key, feature, scope, organization_id, enabled, revision, updated_by_account_id)
    VALUES (${`tenant:${org}`}, 'cms', 'tenant', ${org}, false, 1, ${operator})`;
  assert.equal(await code(createPage(org, operator, { slug: "about", title: "About" })), "feature_disabled");
});

test("draft, publish, immutable versions, rollback as new version, public rendering", async () => {
  const { org, operator } = await cmsTenant();
  const page = await createPage(org, operator, { slug: "about", title: "About", body: "Hello <script>x</script> **world**" });
  assert.equal(await getPublishedPage(org, "about"), null);
  assert.equal(await code(publishPage(org, operator, page.id, { expectedDraftRevision: 2 })), "draft_revision_conflict");
  assert.deepEqual(await publishPage(org, operator, page.id, { expectedDraftRevision: 1 }), { version: 1 });
  const published = await getPublishedPage(org, "about");
  assert.equal(published?.html, "<p>Hello &lt;script&gt;x&lt;/script&gt; <strong>world</strong></p>");

  await updateDraft(org, operator, page.id, { title: "About us", body: "v2", expectedRevision: 1 });
  assert.equal(await code(updateDraft(org, operator, page.id, { title: "x", expectedRevision: 1 })), "draft_revision_conflict");
  assert.equal((await getPublishedPage(org, "about"))?.title, "About", "drafts are not public");
  await publishPage(org, operator, page.id, { expectedDraftRevision: 2 });
  assert.equal((await getPublishedPage(org, "about"))?.title, "About us");

  assert.deepEqual(await rollbackPage(org, operator, page.id, { version: 1 }), { version: 3 });
  const current = await getPublishedPage(org, "about");
  assert.equal(current?.title, "About");
  assert.equal(current?.version, 3);
  await assert.rejects(getSqlClient()`UPDATE cms_page_versions SET title = 'tampered' WHERE page_id = ${page.id}`, /immutable/);
  const editing = await getPageForEditing(org, page.id);
  assert.deepEqual(editing?.versions.map(v => [v.version, v.source, v.source_version]), [[3, "rollback", 1], [2, "publish", null], [1, "publish", null]]);
  const audit = await listAuditEvents(org, { subjectType: "cms_page", subjectId: page.id });
  assert.ok(audit.some(row => row.action === "cms.page_rolled_back"));
});

test("concurrent publishes allocate distinct versions", async () => {
  const { org, operator } = await cmsTenant();
  const page = await createPage(org, operator, { slug: "race", title: "Race" });
  const results = await Promise.allSettled([1, 2, 3].map(() => publishPage(org, operator, page.id, { expectedDraftRevision: 1 })));
  const versions = results.flatMap(result => result.status === "fulfilled" ? [result.value.version] : []).sort();
  assert.deepEqual(versions, [1, 2, 3]);
});

test("scheduled publish freezes the draft and publishes once when due", async () => {
  const { org, operator } = await cmsTenant();
  const page = await createPage(org, operator, { slug: "launch", title: "Launch", body: "frozen" });
  const now = new Date();
  await schedulePublish(org, operator, page.id, { publishAt: new Date(now.getTime() + 60_000).toISOString(), expectedDraftRevision: 1 }, now);
  await updateDraft(org, operator, page.id, { title: "Changed", body: "later", expectedRevision: 1 });
  const later = new Date(now.getTime() + 120_000);
  const runs = await Promise.all([runDueScheduledPublications(later), runDueScheduledPublications(later)]);
  assert.ok(runs.reduce((sum, run) => sum + run.published, 0) >= 1);
  const published = await getPublishedPage(org, "launch");
  assert.equal(published?.title, "Launch");
  assert.equal(published?.version, 1);
  assert.equal(await code(cancelScheduledPublish(org, operator, page.id)), "schedule_not_found");
});

test("moderation-hidden pages and cross-tenant reads are not rendered", async () => {
  const { org, operator } = await cmsTenant();
  const other = await cmsTenant();
  const page = await createPage(org, operator, { slug: "hidden", title: "Hidden" });
  await publishPage(org, operator, page.id, { expectedDraftRevision: 1 });
  assert.equal(await getPublishedPage(other.org, "hidden"), null);
  assert.equal(await code(updateDraft(other.org, other.operator, page.id, { title: "x", expectedRevision: 1 })), "page_not_found");
  assert.equal(await code(publishPage(other.org, other.operator, page.id, { expectedDraftRevision: 1 })), "page_not_found");
  await takeModerationAction(org, operator, { subjectType: "page", subjectId: page.id, action: "takedown", reason: "legal" });
  assert.equal(await getPublishedPage(org, "hidden"), null);
});

test("media references must be live media of the same tenant; navigation targets tenant pages", async () => {
  const { org, operator } = await cmsTenant();
  const other = await cmsTenant();
  const mediaId = randomUUID();
  const foreignMedia = randomUUID();
  await getSqlClient()`INSERT INTO media_library (id, organization_id, owner_account_id) VALUES (${mediaId}, ${org}, ${operator}), (${foreignMedia}, ${other.org}, ${other.operator})`;
  assert.equal(await code(createPage(org, operator, { slug: "m1", title: "M", mediaIds: [foreignMedia] })), "media_not_found");
  const page = await createPage(org, operator, { slug: "m2", title: "M", mediaIds: [mediaId] });
  await publishPage(org, operator, page.id, { expectedDraftRevision: 1 });
  assert.deepEqual((await getPublishedPage(org, "m2"))?.mediaIds, [mediaId]);
  const foreignPage = await createPage(other.org, other.operator, { slug: "x", title: "X" });
  assert.equal(await code(setNavigation(org, operator, [{ label: "X", pageId: foreignPage.id }])), "page_not_found");
  const draftOnly = await createPage(org, operator, { slug: "draft", title: "D" });
  await setNavigation(org, operator, [{ label: "Media", pageId: page.id }, { label: "Draft", pageId: draftOnly.id }, { label: "Home", url: "https://example.org" }]);
  assert.deepEqual((await listNavigation(org, { publicOnly: true })).map(entry => entry.label), ["Media", "Home"]);
});
