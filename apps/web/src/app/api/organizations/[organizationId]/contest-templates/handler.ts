import type { AppliedTemplate, ContestTemplate, TemplateVersion } from "@live-competition-engine/db/contest-templates";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  type Authorizer
} from "../../../../../lib/http";
import { etag, parseIfMatch } from "../../../../../lib/revision";

export interface TemplateDeps {
  parseName(value: unknown): string;
  create(organizationId: string, actorAccountId: string, input: { name: string; config: unknown }): Promise<ContestTemplate>;
  get(organizationId: string, templateId: string): Promise<ContestTemplate | null>;
  list(organizationId: string): Promise<unknown[]>;
  saveDraft(organizationId: string, templateId: string, actorAccountId: string, config: unknown, expectedRevision: number | null): Promise<TemplateVersion>;
  publish(organizationId: string, templateId: string, actorAccountId: string, expectedRevision: number): Promise<TemplateVersion>;
  apply(organizationId: string, competitionId: string, actorAccountId: string, templateVersionId: string, expectedEventRevision: number): Promise<AppliedTemplate>;
  getApplied(organizationId: string, competitionId: string): Promise<{ eventRevision: number } & Record<string, unknown> | null>;
}

const MAX_CONFIG_BYTES = 64 * 1024;

/** Validation errors carry bounded `issues` (path + message) for template authors. */
function failure(error: unknown): Response {
  const issues = (error as { issues?: unknown })?.issues;
  if ((error as { code?: unknown })?.code === "invalid_template_config" && Array.isArray(issues)) {
    return errorResponse(400, "invalid_template_config", { issues });
  }
  return domainFailure(error);
}

/** Templates are tenant-owned: tenant-scope event.manage. Applying uses competition scope. */
export function createTemplateHandlers(authorizer: Authorizer, deps: TemplateDeps) {
  const manage = (request: Request, organizationId: string) =>
    requireAction(authorizer, request, "event.manage", { organizationId });

  return {
    async list(request: Request, organizationId: string): Promise<Response> {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      return json({ templates: await deps.list(organizationId) });
    },

    async create(request: Request, organizationId: string): Promise<Response> {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, MAX_CONFIG_BYTES);
      if (body instanceof Response) return body;
      try {
        return json(await deps.create(organizationId, principal.accountId, { name: deps.parseName(body.name), config: body.config }), 201);
      } catch (error) {
        return failure(error);
      }
    },

    async get(request: Request, organizationId: string, templateId: string): Promise<Response> {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(templateId)) return errorResponse(404, "contest_template_not_found");
      const template = await deps.get(organizationId, templateId);
      return template ? json(template) : errorResponse(404, "contest_template_not_found");
    },

    /** PUT { config }: update the draft (If-Match: draft revision) or open a new one (no If-Match). */
    async saveDraft(request: Request, organizationId: string, templateId: string): Promise<Response> {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(templateId)) return errorResponse(404, "contest_template_not_found");
      const expected = parseIfMatch(request);
      if (expected === "invalid") return errorResponse(400, "invalid_if_match");
      const body = await readJsonObject(request, MAX_CONFIG_BYTES);
      if (body instanceof Response) return body;
      try {
        const version = await deps.saveDraft(organizationId, templateId, principal.accountId, body.config, expected);
        return json(version, expected === null ? 201 : 200, etag(version.revision));
      } catch (error) {
        return failure(error);
      }
    },

    async publish(request: Request, organizationId: string, templateId: string): Promise<Response> {
      const principal = await manage(request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(templateId)) return errorResponse(404, "contest_template_not_found");
      const expected = parseIfMatch(request);
      if (expected === "invalid") return errorResponse(400, "invalid_if_match");
      if (expected === null) return errorResponse(428, "if_match_required");
      try {
        return json(await deps.publish(organizationId, templateId, principal.accountId, expected));
      } catch (error) {
        return failure(error);
      }
    },

    async getApplied(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId });
      if (principal instanceof Response) return principal;
      const applied = await deps.getApplied(organizationId, competitionId);
      return applied ? json(applied, 200, etag(applied.eventRevision)) : errorResponse(404, "event_not_found");
    },

    /** PUT { templateVersionId } with If-Match: event revision. */
    async apply(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await requireAction(authorizer, request, "event.manage", { organizationId, competitionId });
      if (principal instanceof Response) return principal;
      const expected = parseIfMatch(request);
      if (expected === "invalid") return errorResponse(400, "invalid_if_match");
      if (expected === null) return errorResponse(428, "if_match_required");
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      if (!isUuid(body.templateVersionId)) return errorResponse(400, "invalid_template_version");
      try {
        const applied = await deps.apply(organizationId, competitionId, principal.accountId, body.templateVersionId, expected);
        return json(applied, 200, etag(applied.eventRevision));
      } catch (error) {
        return failure(error);
      }
    }
  };
}
