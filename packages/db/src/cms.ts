import { DomainError, isUuid } from "@live-competition-engine/domain";
import { parseNavigation, parsePageContent, parsePublishAt, parseSlug, type PageContent } from "@live-competition-engine/domain/cms";
import { renderMarkdown } from "@live-competition-engine/domain/markdown";
import { recordAudit, type Sql } from "./audit.ts";
import { isFeatureEnabled, requireEnabledFeature } from "./feature-guard.ts";
import { getSqlClient } from "./index.ts";
import { isSubjectHidden } from "./moderation.ts";

/**
 * LC-45 content management (feature `cms`). Admin functions require the caller to have
 * authorized tenant.manage; they check the feature before any side effect. Published
 * versions are immutable (trigger); rollback publishes an older version's content as a
 * new version. Public reads return only the published projection.
 */

async function assertMediaUsable(tx: Sql, organizationId: string, mediaIds: string[]): Promise<void> {
  if (mediaIds.length === 0) return;
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM media_library WHERE organization_id = ${organizationId} AND id IN ${tx(mediaIds)} AND revoked_at IS NULL
  `;
  if (rows.length !== mediaIds.length) throw new DomainError("media_not_found");
}

export interface PageSummary {
  id: string;
  slug: string;
  draftTitle: string;
  draftRevision: number;
  publishedVersion: number | null;
  updatedAt: Date;
  scheduledAt: Date | null;
}

type PageRow = {
  id: string; slug: string; draft_title: string; draft_body: string; draft_media_ids: string[]; draft_revision: number;
  published_version: number | null; updated_at: Date;
};

export async function createPage(
  organizationId: string, actorAccountId: string, input: { slug?: unknown; title?: unknown; body?: unknown; mediaIds?: unknown }
): Promise<{ id: string; slug: string; draftRevision: number }> {
  const slug = parseSlug(input.slug);
  const content = parsePageContent(input);
  await requireEnabledFeature("cms", { organizationId });
  try {
    return await getSqlClient().begin(async tx => {
      await assertMediaUsable(tx, organizationId, content.mediaIds);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO cms_pages (organization_id, slug, draft_title, draft_body, draft_media_ids, created_by_account_id)
        VALUES (${organizationId}, ${slug}, ${content.title}, ${content.body}, ${content.mediaIds}::uuid[], ${actorAccountId})
        RETURNING id
      `;
      await recordAudit(tx, { organizationId, actorAccountId, action: "cms.page_created", subjectType: "cms_page", subjectId: row!.id, details: { slug } });
      return { id: row!.id, slug, draftRevision: 1 };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") throw new DomainError("slug_conflict");
    throw error;
  }
}

export async function updateDraft(
  organizationId: string, actorAccountId: string, pageId: string,
  input: { title?: unknown; body?: unknown; mediaIds?: unknown; expectedRevision?: unknown }
): Promise<{ draftRevision: number }> {
  if (!isUuid(pageId)) throw new DomainError("page_not_found");
  const content = parsePageContent(input);
  const expected = input.expectedRevision;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1) throw new DomainError("invalid_expected_revision");
  await requireEnabledFeature("cms", { organizationId });
  return getSqlClient().begin(async tx => {
    await assertMediaUsable(tx, organizationId, content.mediaIds);
    const [row] = await tx<{ draft_revision: number }[]>`
      UPDATE cms_pages SET draft_title = ${content.title}, draft_body = ${content.body}, draft_media_ids = ${content.mediaIds}::uuid[],
        draft_revision = draft_revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${pageId} AND draft_revision = ${expected}
      RETURNING draft_revision
    `;
    if (!row) {
      const exists = await tx`SELECT 1 FROM cms_pages WHERE organization_id = ${organizationId} AND id = ${pageId}`;
      throw new DomainError(exists.length ? "draft_revision_conflict" : "page_not_found");
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "cms.draft_updated", subjectType: "cms_page", subjectId: pageId, details: { draftRevision: row.draft_revision } });
    return { draftRevision: row.draft_revision };
  });
}

async function insertVersion(
  tx: Sql, organizationId: string, actorAccountId: string, pageId: string, content: PageContent,
  source: "publish" | "rollback" | "schedule", sourceVersion: number | null
): Promise<number> {
  const [next] = await tx<{ version: number }[]>`
    SELECT COALESCE(max(version), 0) + 1 AS version FROM cms_page_versions WHERE page_id = ${pageId}
  `;
  const version = next!.version;
  const html = renderMarkdown(content.body);
  await tx`
    INSERT INTO cms_page_versions (organization_id, page_id, version, title, body, rendered_html, media_ids, source, source_version, published_by_account_id)
    VALUES (${organizationId}, ${pageId}, ${version}, ${content.title}, ${content.body}, ${html}, ${content.mediaIds}::uuid[],
      ${source}, ${sourceVersion}, ${actorAccountId})
  `;
  await tx`UPDATE cms_pages SET published_version = ${version}, updated_at = now() WHERE organization_id = ${organizationId} AND id = ${pageId}`;
  await recordAudit(tx, {
    organizationId, actorAccountId, action: source === "rollback" ? "cms.page_rolled_back" : "cms.page_published",
    subjectType: "cms_page", subjectId: pageId, details: { version, source, sourceVersion }
  });
  return version;
}

async function lockPage(tx: Sql, organizationId: string, pageId: string): Promise<PageRow> {
  if (!isUuid(pageId)) throw new DomainError("page_not_found");
  const [page] = await tx<PageRow[]>`
    SELECT id, slug, draft_title, draft_body, draft_media_ids, draft_revision, published_version, updated_at
    FROM cms_pages WHERE organization_id = ${organizationId} AND id = ${pageId} FOR UPDATE
  `;
  if (!page) throw new DomainError("page_not_found");
  return page;
}

/** Publish the current draft as a new immutable version. expectedDraftRevision guards against publishing unseen edits. */
export async function publishPage(
  organizationId: string, actorAccountId: string, pageId: string, input: { expectedDraftRevision?: unknown }
): Promise<{ version: number }> {
  await requireEnabledFeature("cms", { organizationId });
  return getSqlClient().begin(async tx => {
    const page = await lockPage(tx, organizationId, pageId);
    if (input.expectedDraftRevision !== page.draft_revision) throw new DomainError("draft_revision_conflict");
    await assertMediaUsable(tx, organizationId, page.draft_media_ids);
    const version = await insertVersion(tx, organizationId, actorAccountId, pageId,
      { title: page.draft_title, body: page.draft_body, mediaIds: page.draft_media_ids }, "publish", null);
    return { version };
  });
}

/** Roll back = publish an older version's content as a new version; history is never rewritten. */
export async function rollbackPage(
  organizationId: string, actorAccountId: string, pageId: string, input: { version?: unknown }
): Promise<{ version: number }> {
  const target = input.version;
  if (typeof target !== "number" || !Number.isSafeInteger(target) || target < 1) throw new DomainError("invalid_version");
  await requireEnabledFeature("cms", { organizationId });
  return getSqlClient().begin(async tx => {
    await lockPage(tx, organizationId, pageId);
    const [old] = await tx<{ title: string; body: string; media_ids: string[] }[]>`
      SELECT title, body, media_ids FROM cms_page_versions WHERE organization_id = ${organizationId} AND page_id = ${pageId} AND version = ${target}
    `;
    if (!old) throw new DomainError("version_not_found");
    const version = await insertVersion(tx, organizationId, actorAccountId, pageId,
      { title: old.title, body: old.body, mediaIds: old.media_ids }, "rollback", target);
    return { version };
  });
}

/** Freeze the current draft for publication at publishAt (replaces any pending schedule). */
export async function schedulePublish(
  organizationId: string, actorAccountId: string, pageId: string, input: { publishAt?: unknown; expectedDraftRevision?: unknown }, now = new Date()
): Promise<{ id: string; publishAt: Date }> {
  const publishAt = parsePublishAt(input.publishAt, now);
  await requireEnabledFeature("cms", { organizationId });
  return getSqlClient().begin(async tx => {
    const page = await lockPage(tx, organizationId, pageId);
    if (input.expectedDraftRevision !== page.draft_revision) throw new DomainError("draft_revision_conflict");
    await tx`UPDATE cms_scheduled_publications SET status = 'cancelled' WHERE organization_id = ${organizationId} AND page_id = ${pageId} AND status = 'pending'`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO cms_scheduled_publications (organization_id, page_id, title, body, media_ids, publish_at, created_by_account_id)
      VALUES (${organizationId}, ${pageId}, ${page.draft_title}, ${page.draft_body}, ${page.draft_media_ids}::uuid[], ${publishAt}, ${actorAccountId})
      RETURNING id
    `;
    await recordAudit(tx, { organizationId, actorAccountId, action: "cms.publish_scheduled", subjectType: "cms_page", subjectId: pageId, details: { scheduleId: row!.id, publishAt: publishAt.toISOString() } });
    return { id: row!.id, publishAt };
  });
}

export async function cancelScheduledPublish(organizationId: string, actorAccountId: string, pageId: string): Promise<void> {
  if (!isUuid(pageId)) throw new DomainError("page_not_found");
  await getSqlClient().begin(async tx => {
    const rows = await tx`
      UPDATE cms_scheduled_publications SET status = 'cancelled'
      WHERE organization_id = ${organizationId} AND page_id = ${pageId} AND status = 'pending' RETURNING id
    `;
    if (rows.length !== 1) throw new DomainError("schedule_not_found");
    await recordAudit(tx, { organizationId, actorAccountId, action: "cms.publish_schedule_cancelled", subjectType: "cms_page", subjectId: pageId });
  });
}

/**
 * Worker entry point: publish due schedules. Uses SKIP LOCKED so concurrent workers never
 * publish the same schedule twice. Schedules for tenants whose `cms` feature is off stay pending.
 */
export async function runDueScheduledPublications(now = new Date(), limit = 50): Promise<{ published: number; skipped: number }> {
  let published = 0;
  let skipped = 0;
  for (let i = 0; i < limit; i += 1) {
    const outcome = await getSqlClient().begin(async tx => {
      const [due] = await tx<{ id: string; organization_id: string; page_id: string; title: string; body: string; media_ids: string[]; created_by_account_id: string }[]>`
        SELECT id, organization_id, page_id, title, body, media_ids, created_by_account_id FROM cms_scheduled_publications
        WHERE status = 'pending' AND publish_at <= ${now}
        ORDER BY publish_at LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      if (!due) return "none" as const;
      if (!(await isFeatureEnabled("cms", { organizationId: due.organization_id }))) {
        // Push it back so other due rows are reached; it is retried on a later run.
        await tx`UPDATE cms_scheduled_publications SET publish_at = ${new Date(now.getTime() + 60_000)} WHERE id = ${due.id}`;
        return "skipped" as const;
      }
      await lockPage(tx, due.organization_id, due.page_id);
      const version = await insertVersion(tx, due.organization_id, due.created_by_account_id, due.page_id,
        { title: due.title, body: due.body, mediaIds: due.media_ids }, "schedule", null);
      await tx`UPDATE cms_scheduled_publications SET status = 'published', published_version = ${version} WHERE id = ${due.id}`;
      return "published" as const;
    });
    if (outcome === "none") break;
    if (outcome === "published") published += 1; else skipped += 1;
  }
  return { published, skipped };
}

export async function listPages(organizationId: string): Promise<PageSummary[]> {
  const rows = await getSqlClient()<(PageRow & { scheduled_at: Date | null })[]>`
    SELECT p.id, p.slug, p.draft_title, p.draft_body, p.draft_media_ids, p.draft_revision, p.published_version, p.updated_at,
      (SELECT publish_at FROM cms_scheduled_publications s WHERE s.page_id = p.id AND s.status = 'pending') AS scheduled_at
    FROM cms_pages p WHERE p.organization_id = ${organizationId} ORDER BY p.slug LIMIT 500
  `;
  return rows.map(row => ({
    id: row.id, slug: row.slug, draftTitle: row.draft_title, draftRevision: row.draft_revision,
    publishedVersion: row.published_version, updatedAt: row.updated_at, scheduledAt: row.scheduled_at
  }));
}

export async function getPageForEditing(organizationId: string, pageId: string) {
  if (!isUuid(pageId)) return null;
  const sql = getSqlClient();
  const [page] = await sql<PageRow[]>`
    SELECT id, slug, draft_title, draft_body, draft_media_ids, draft_revision, published_version, updated_at
    FROM cms_pages WHERE organization_id = ${organizationId} AND id = ${pageId}
  `;
  if (!page) return null;
  const versions = await sql<{ version: number; title: string; source: string; source_version: number | null; published_at: Date }[]>`
    SELECT version, title, source, source_version, published_at FROM cms_page_versions
    WHERE organization_id = ${organizationId} AND page_id = ${pageId} ORDER BY version DESC
  `;
  return {
    id: page.id, slug: page.slug, draft: { title: page.draft_title, body: page.draft_body, mediaIds: page.draft_media_ids, revision: page.draft_revision },
    publishedVersion: page.published_version, versions
  };
}

export interface PublishedPage {
  pageId: string;
  slug: string;
  title: string;
  html: string;
  version: number;
  publishedAt: Date;
  mediaIds: string[];
}

/** Public projection. Returns null when cms is off, the page is unpublished or moderation hid it. */
export async function getPublishedPage(organizationId: string, slugInput: string): Promise<PublishedPage | null> {
  if (!isUuid(organizationId)) return null;
  let slug: string;
  try { slug = parseSlug(slugInput); } catch { return null; }
  const sql = getSqlClient();
  const [row] = await sql<{ page_id: string; slug: string; title: string; rendered_html: string; version: number; published_at: Date; media_ids: string[] }[]>`
    SELECT p.id AS page_id, p.slug, v.title, v.rendered_html, v.version, v.published_at, v.media_ids
    FROM cms_pages p JOIN cms_page_versions v ON v.page_id = p.id AND v.version = p.published_version
    WHERE p.organization_id = ${organizationId} AND p.slug = ${slug}
  `;
  if (!row) return null;
  if (!(await isFeatureEnabled("cms", { organizationId }))) return null;
  if (await isSubjectHidden(organizationId, "page", row.page_id)) return null;
  return { pageId: row.page_id, slug: row.slug, title: row.title, html: row.rendered_html, version: row.version, publishedAt: row.published_at, mediaIds: row.media_ids };
}

export async function setNavigation(organizationId: string, actorAccountId: string, entriesInput: unknown): Promise<{ count: number }> {
  const entries = parseNavigation(entriesInput);
  await requireEnabledFeature("cms", { organizationId });
  return getSqlClient().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"cms-nav:" + organizationId}, 0))`;
    const pageIds = entries.flatMap(entry => entry.pageId ? [entry.pageId] : []);
    if (pageIds.length) {
      const pages = await tx`SELECT id FROM cms_pages WHERE organization_id = ${organizationId} AND id IN ${tx(pageIds)}`;
      if (pages.length !== new Set(pageIds).size) throw new DomainError("page_not_found");
    }
    await tx`DELETE FROM cms_navigation_entries WHERE organization_id = ${organizationId}`;
    for (const entry of entries) {
      await tx`
        INSERT INTO cms_navigation_entries (organization_id, label, page_id, url, position)
        VALUES (${organizationId}, ${entry.label}, ${entry.pageId}, ${entry.url}, ${entry.position})
      `;
    }
    await recordAudit(tx, { organizationId, actorAccountId, action: "cms.navigation_set", subjectType: "cms_navigation", subjectId: organizationId, details: { count: entries.length } });
    return { count: entries.length };
  });
}

/** Navigation for public rendering: only links to published, visible pages or external URLs. */
export async function listNavigation(organizationId: string, options: { publicOnly?: boolean } = {}) {
  if (!isUuid(organizationId)) return [];
  const rows = await getSqlClient()<{ id: string; label: string; page_id: string | null; url: string | null; slug: string | null; published_version: number | null }[]>`
    SELECT n.id, n.label, n.page_id, n.url, p.slug, p.published_version
    FROM cms_navigation_entries n LEFT JOIN cms_pages p ON p.organization_id = n.organization_id AND p.id = n.page_id
    WHERE n.organization_id = ${organizationId} ORDER BY n.position
  `;
  const result: Array<{ label: string; href: string; pageId: string | null }> = [];
  for (const row of rows) {
    if (row.page_id) {
      if (options.publicOnly && (row.published_version === null || await isSubjectHidden(organizationId, "page", row.page_id))) continue;
      result.push({ label: row.label, href: `/pages/${organizationId}/${row.slug}`, pageId: row.page_id });
    } else if (row.url) {
      result.push({ label: row.label, href: row.url, pageId: null });
    }
  }
  return result;
}
