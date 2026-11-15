import type * as admin from "@live-competition-engine/db/platform-admin";
import { isUuid } from "@live-competition-engine/domain";
import { TENANT_STATUSES, type TenantStatus } from "@live-competition-engine/domain/platform-admin";
import { domainFailure, errorResponse, json, readJsonObject, requireAction, requireMember, type Authorizer } from "../../../../lib/http";

export interface PlatformAdminDeps {
  stepUpWithRecoveryCode: typeof admin.stepUpWithRecoveryCode;
  stepUpWithFreshSession: typeof admin.stepUpWithFreshSession;
  revokeStepUp: typeof admin.revokeStepUp;
  listTenants: typeof admin.listTenants;
  getTenantDetail: typeof admin.getTenantDetail;
  changeTenantLifecycle: typeof admin.changeTenantLifecycle;
  addSupportNote: typeof admin.addSupportNote;
  listSupportNotes: typeof admin.listSupportNotes;
  raiseFraudFlag: typeof admin.raiseFraudFlag;
  resolveFraudFlag: typeof admin.resolveFraudFlag;
  listFraudFlags: typeof admin.listFraudFlags;
  createAnnouncement: typeof admin.createAnnouncement;
  addAnnouncementVersion: typeof admin.addAnnouncementVersion;
  publishAnnouncementVersion: typeof admin.publishAnnouncementVersion;
  withdrawAnnouncement: typeof admin.withdrawAnnouncement;
  listAnnouncements: typeof admin.listAnnouncements;
  listTenantAnnouncements: typeof admin.listTenantAnnouncements;
  platformAudit: typeof admin.platformAudit;
}

export const STEP_UP_HEADER = "x-step-up-token";

const codes = { step_up_required: 403, step_up_failed: 403, flag_subject_not_found: 404 };

const intParam = (value: string | null, min: number, max: number): number | undefined | null => {
  if (value === null) return undefined;
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n < min || n > max ? null : n;
};

/**
 * LC-53 platform super-admin API. Every route requires `platform.manage` (a platform_operator
 * grant with no tenant scope). Destructive lifecycle actions also require the X-Step-Up-Token
 * header. There is deliberately no impersonation endpoint.
 */
export function createPlatformAdminHandlers(authorizer: Pick<Authorizer, "authorize" | "authorizeAction">, deps: PlatformAdminDeps) {
  const operator = async (request: Request) => {
    const principal = await requireAction(authorizer, request, "platform.manage");
    if (principal instanceof Response) return principal;
    return { accountId: principal.accountId, sessionId: principal.sessionId };
  };
  const run = async (fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (error) {
      return domainFailure(error, codes);
    }
  };

  return {
    async stepUp(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => {
        const grant = body.method === "recovery_code" ? await deps.stepUpWithRecoveryCode(actor, body.recoveryCode)
          : body.method === "fresh_session" ? await deps.stepUpWithFreshSession(actor)
          : null;
        if (!grant) return errorResponse(400, "invalid_step_up_method");
        return json({ token: grant.token, method: grant.method, expiresAt: grant.expiresAt, header: STEP_UP_HEADER }, 201);
      });
    },

    async revokeStepUp(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      return json({ revoked: await deps.revokeStepUp(actor) });
    },

    async listTenants(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const params = new URL(request.url).searchParams;
      const status = params.get("status");
      const limit = intParam(params.get("limit"), 1, 200);
      const offset = intParam(params.get("offset"), 0, 100_000);
      const q = params.get("q");
      if ((status !== null && !(TENANT_STATUSES as readonly string[]).includes(status)) || limit === null || offset === null || (q !== null && q.length > 100)) {
        return errorResponse(400, "invalid_query");
      }
      return json({ tenants: await deps.listTenants({
        ...(status ? { status: status as TenantStatus } : {}), ...(q ? { query: q } : {}),
        ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {})
      }) });
    },

    async getTenant(request: Request, organizationId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const detail = isUuid(organizationId) ? await deps.getTenantDetail(organizationId) : null;
      return detail ? json(detail) : errorResponse(404, "tenant_not_found");
    },

    async lifecycle(request: Request, organizationId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      return run(async () => json({ tenant: await deps.changeTenantLifecycle(actor, organizationId,
        { action: body.action, reason: body.reason, expectedRevision: body.expectedRevision },
        request.headers.get(STEP_UP_HEADER)) }));
    },

    async listNotes(request: Request, organizationId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      if (!isUuid(organizationId)) return errorResponse(404, "tenant_not_found");
      return json({ notes: await deps.listSupportNotes(organizationId) });
    },

    async addNote(request: Request, organizationId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 16 * 1024);
      if (body instanceof Response) return body;
      return run(async () => json({ note: await deps.addSupportNote(actor, organizationId, body.body) }, 201));
    },

    async listFlags(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const params = new URL(request.url).searchParams;
      const status = params.get("status");
      const organizationId = params.get("organizationId");
      const accountId = params.get("accountId");
      if ((status !== null && status !== "open" && status !== "resolved") ||
          (organizationId !== null && !isUuid(organizationId)) || (accountId !== null && !isUuid(accountId))) {
        return errorResponse(400, "invalid_query");
      }
      return json({ flags: await deps.listFraudFlags({
        ...(status ? { status: status as "open" | "resolved" } : {}),
        ...(organizationId ? { organizationId } : {}), ...(accountId ? { accountId } : {})
      }) });
    },

    async raiseFlag(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      return run(async () => json({ flag: await deps.raiseFraudFlag(actor, body) }, 201));
    },

    async resolveFlag(request: Request, flagId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      return run(async () => json({ flag: await deps.resolveFraudFlag(actor, flagId, body.resolution, body.expectedRevision) }));
    },

    async listAnnouncements(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      return json({ announcements: await deps.listAnnouncements() });
    },

    async createAnnouncement(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 64 * 1024);
      if (body instanceof Response) return body;
      return run(async () => json({ version: await deps.createAnnouncement(actor, body.kind, body) }, 201));
    },

    async addAnnouncementVersion(request: Request, announcementId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 64 * 1024);
      if (body instanceof Response) return body;
      return run(async () => json({ version: await deps.addAnnouncementVersion(actor, announcementId, body) }, 201));
    },

    async publishAnnouncement(request: Request, announcementId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => json({ version: await deps.publishAnnouncementVersion(actor, announcementId, body.version) }));
    },

    async withdrawAnnouncement(request: Request, announcementId: string): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      return run(async () => {
        await deps.withdrawAnnouncement(actor, announcementId);
        return json({ withdrawn: true });
      });
    },

    async audit(request: Request): Promise<Response> {
      const actor = await operator(request);
      if (actor instanceof Response) return actor;
      const params = new URL(request.url).searchParams;
      const limit = intParam(params.get("limit"), 1, 200);
      const before = intParam(params.get("before"), 1, 999_999_999);
      if (limit === null || before === null) return errorResponse(400, "invalid_query");
      return json(await deps.platformAudit({ ...(limit ? { limit } : {}), ...(before ? { beforeSequence: before } : {}) }));
    },

    /** Tenant members read published announcements. Deliberately NOT blocked for suspended tenants. */
    async tenantAnnouncements(request: Request, organizationId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      return json({ announcements: await deps.listTenantAnnouncements(organizationId) });
    }
  };
}
