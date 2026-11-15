import { createHash } from "node:crypto";
import type postgres from "postgres";
import { DomainError, isUuid } from "@live-competition-engine/domain";
import { canApplyTemplate, parseTemplateConfig, type TemplateConfig } from "@live-competition-engine/domain/contest-templates";
import { canonicalJson, recordAudit, type Sql } from "./audit.ts";
import { getSqlClient } from "./index.ts";

/**
 * LC-14 versioned contest templates. A template owns numbered versions; at most one
 * is a mutable draft (optimistic `revision`), every published version is immutable
 * (database trigger). Applying a version to an event stores the version id and a
 * resolved snapshot so later template revisions never change a configured event.
 */
export interface TemplateVersion {
  id: string;
  version: number;
  status: "draft" | "published";
  revision: number;
  configHash: string;
  config: TemplateConfig;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface ContestTemplate {
  id: string;
  name: string;
  createdAt: Date;
  versions: TemplateVersion[];
}

interface VersionRow {
  id: string; version: number; status: "draft" | "published"; revision: number; config_hash: string;
  config: TemplateConfig; created_at: Date; published_at: Date | null;
}

const toVersion = (row: VersionRow): TemplateVersion => ({
  id: row.id, version: row.version, status: row.status, revision: row.revision, configHash: row.config_hash,
  config: row.config, createdAt: row.created_at, publishedAt: row.published_at
});

export function templateConfigHash(config: TemplateConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

const json = (tx: Sql, value: TemplateConfig) => tx.json(value as unknown as postgres.JSONValue);

export async function createContestTemplate(
  organizationId: string,
  actorAccountId: string,
  input: { name: string; config: unknown }
): Promise<ContestTemplate> {
  const config = parseTemplateConfig(input.config);
  if (!isUuid(organizationId)) throw new DomainError("organization_not_found");
  try {
    const templateId = await getSqlClient().begin(async tx => {
      const [template] = await tx<{ id: string }[]>`
        INSERT INTO contest_templates (organization_id, name, created_by_account_id)
        VALUES (${organizationId}, ${input.name}, ${actorAccountId}) RETURNING id
      `;
      const hash = templateConfigHash(config);
      await tx`
        INSERT INTO contest_template_versions (organization_id, template_id, version, status, config, config_hash, created_by_account_id)
        VALUES (${organizationId}, ${template!.id}, 1, 'draft', ${json(tx, config)}, ${hash}, ${actorAccountId})
      `;
      await recordAudit(tx, {
        organizationId, actorAccountId, action: "contest_template.created", subjectType: "contest_template",
        subjectId: template!.id, details: { name: input.name, configHash: hash }
      });
      return template!.id;
    });
    return (await getContestTemplate(organizationId, templateId))!;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new DomainError("contest_template_name_conflict");
    throw error;
  }
}

export async function getContestTemplate(organizationId: string, templateId: string, sql: Sql = getSqlClient()): Promise<ContestTemplate | null> {
  if (!isUuid(organizationId) || !isUuid(templateId)) return null;
  const [template] = await sql<{ id: string; name: string; created_at: Date }[]>`
    SELECT id, name, created_at FROM contest_templates WHERE organization_id = ${organizationId} AND id = ${templateId}
  `;
  if (!template) return null;
  const versions = await sql<VersionRow[]>`
    SELECT id, version, status, revision, config_hash, config, created_at, published_at
    FROM contest_template_versions WHERE organization_id = ${organizationId} AND template_id = ${templateId}
    ORDER BY version
  `;
  return { id: template.id, name: template.name, createdAt: template.created_at, versions: versions.map(toVersion) };
}

export async function listContestTemplates(organizationId: string) {
  if (!isUuid(organizationId)) return [];
  return getSqlClient()<{ id: string; name: string; latest_published_version: number | null; has_draft: boolean }[]>`
    SELECT t.id, t.name,
      (SELECT max(version) FROM contest_template_versions v WHERE v.template_id = t.id AND v.status = 'published') AS latest_published_version,
      EXISTS (SELECT 1 FROM contest_template_versions v WHERE v.template_id = t.id AND v.status = 'draft') AS has_draft
    FROM contest_templates t WHERE t.organization_id = ${organizationId}
    ORDER BY lower(t.name), t.id LIMIT 200
  `;
}

async function lockTemplate(tx: Sql, organizationId: string, templateId: string): Promise<void> {
  if (!isUuid(organizationId) || !isUuid(templateId)) throw new DomainError("contest_template_not_found");
  const [row] = await tx`SELECT id FROM contest_templates WHERE organization_id = ${organizationId} AND id = ${templateId} FOR UPDATE`;
  if (!row) throw new DomainError("contest_template_not_found");
}

/**
 * Save the template's draft. With an existing draft, expectedRevision must match it.
 * Without a draft, expectedRevision must be null and a new draft version
 * (max version + 1) is opened; published versions are never touched.
 */
export async function saveContestTemplateDraft(
  organizationId: string,
  templateId: string,
  actorAccountId: string,
  rawConfig: unknown,
  expectedRevision: number | null
): Promise<TemplateVersion> {
  const config = parseTemplateConfig(rawConfig);
  const hash = templateConfigHash(config);
  return getSqlClient().begin(async tx => {
    await lockTemplate(tx, organizationId, templateId);
    const [draft] = await tx<{ id: string; revision: number }[]>`
      SELECT id, revision FROM contest_template_versions WHERE template_id = ${templateId} AND status = 'draft'
    `;
    let row: VersionRow | undefined;
    if (draft) {
      if (expectedRevision !== draft.revision) throw new DomainError("contest_template_revision_conflict");
      [row] = await tx<VersionRow[]>`
        UPDATE contest_template_versions SET config = ${json(tx, config)}, config_hash = ${hash}, revision = revision + 1
        WHERE id = ${draft.id}
        RETURNING id, version, status, revision, config_hash, config, created_at, published_at
      `;
    } else {
      if (expectedRevision !== null) throw new DomainError("contest_template_revision_conflict");
      [row] = await tx<VersionRow[]>`
        INSERT INTO contest_template_versions (organization_id, template_id, version, status, config, config_hash, created_by_account_id)
        SELECT ${organizationId}, ${templateId}, COALESCE(max(version), 0) + 1, 'draft', ${json(tx, config)}, ${hash}, ${actorAccountId}
        FROM contest_template_versions WHERE template_id = ${templateId}
        RETURNING id, version, status, revision, config_hash, config, created_at, published_at
      `;
    }
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "contest_template.draft_saved", subjectType: "contest_template",
      subjectId: templateId, details: { version: row!.version, revision: row!.revision, configHash: hash }
    });
    return toVersion(row!);
  });
}

/** Publish the current draft (If-Match: draft revision). The version becomes immutable. */
export async function publishContestTemplateDraft(
  organizationId: string,
  templateId: string,
  actorAccountId: string,
  expectedRevision: number
): Promise<TemplateVersion> {
  return getSqlClient().begin(async tx => {
    await lockTemplate(tx, organizationId, templateId);
    const [draft] = await tx<VersionRow[]>`
      SELECT id, version, status, revision, config_hash, config, created_at, published_at
      FROM contest_template_versions WHERE template_id = ${templateId} AND status = 'draft'
    `;
    if (!draft) throw new DomainError("contest_template_draft_not_found");
    if (draft.revision !== expectedRevision) throw new DomainError("contest_template_revision_conflict");
    // Re-validate stored JSON so nothing invalid can be frozen.
    const config = parseTemplateConfig(draft.config);
    if (templateConfigHash(config) !== draft.config_hash) throw new DomainError("invalid_state_template_hash_mismatch");
    const [row] = await tx<VersionRow[]>`
      UPDATE contest_template_versions SET status = 'published', published_at = now(), published_by_account_id = ${actorAccountId}
      WHERE id = ${draft.id}
      RETURNING id, version, status, revision, config_hash, config, created_at, published_at
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "contest_template.version_published", subjectType: "contest_template",
      subjectId: templateId, details: { versionId: draft.id, version: draft.version, configHash: draft.config_hash }
    });
    return toVersion(row!);
  });
}

export interface AppliedTemplate {
  competitionId: string;
  templateVersionId: string;
  templateId: string;
  version: number;
  configHash: string;
  snapshot: TemplateConfig;
  appliedAt: Date;
  eventRevision: number;
}

/**
 * Apply a PUBLISHED version to an event that has not started (draft/published).
 * Requires the event revision (If-Match); bumps it; audited.
 */
export async function applyTemplateVersion(
  organizationId: string,
  competitionId: string,
  actorAccountId: string,
  templateVersionId: string,
  expectedEventRevision: number
): Promise<AppliedTemplate> {
  if (!isUuid(organizationId) || !isUuid(competitionId)) throw new DomainError("event_not_found");
  if (!isUuid(templateVersionId)) throw new DomainError("contest_template_version_not_found");
  return getSqlClient().begin(async tx => {
    const [event] = await tx<{ status: string; revision: number }[]>`
      SELECT status, revision FROM competitions WHERE organization_id = ${organizationId} AND id = ${competitionId} FOR UPDATE
    `;
    if (!event) throw new DomainError("event_not_found");
    if (event.revision !== expectedEventRevision) throw new DomainError("event_revision_conflict");
    if (!canApplyTemplate(event.status)) throw new DomainError("invalid_state_event_started");
    const [version] = await tx<{ id: string; template_id: string; version: number; config: TemplateConfig; config_hash: string }[]>`
      SELECT id, template_id, version, config, config_hash FROM contest_template_versions
      WHERE organization_id = ${organizationId} AND id = ${templateVersionId} AND status = 'published'
      FOR SHARE
    `;
    if (!version) throw new DomainError("contest_template_version_not_found");
    const [row] = await tx<{ revision: number; template_applied_at: Date }[]>`
      UPDATE competitions SET template_version_id = ${version.id}, template_snapshot = ${json(tx, version.config)},
        template_applied_at = now(), revision = revision + 1, updated_at = now()
      WHERE organization_id = ${organizationId} AND id = ${competitionId}
      RETURNING revision, template_applied_at
    `;
    await recordAudit(tx, {
      organizationId, actorAccountId, action: "event.template_applied", subjectType: "competition", subjectId: competitionId,
      details: { templateId: version.template_id, templateVersionId: version.id, version: version.version, configHash: version.config_hash }
    });
    return {
      competitionId, templateVersionId: version.id, templateId: version.template_id, version: version.version,
      configHash: version.config_hash, snapshot: version.config, appliedAt: row!.template_applied_at, eventRevision: row!.revision
    };
  });
}

export async function getAppliedTemplate(organizationId: string, competitionId: string) {
  if (!isUuid(organizationId) || !isUuid(competitionId)) return null;
  const [row] = await getSqlClient()<{ template_version_id: string | null; template_snapshot: TemplateConfig | null; template_applied_at: Date | null; revision: number }[]>`
    SELECT template_version_id, template_snapshot, template_applied_at, revision FROM competitions
    WHERE organization_id = ${organizationId} AND id = ${competitionId}
  `;
  if (!row) return null;
  return { templateVersionId: row.template_version_id, snapshot: row.template_snapshot, appliedAt: row.template_applied_at, eventRevision: row.revision };
}
