import type { AuthorizedPrincipal } from "@live-competition-engine/auth";
import type { Reporter } from "@live-competition-engine/db/moderation";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  optionalMember,
  readJsonObject,
  requireAction,
  requireMember,
  type Authorizer
} from "../../../../../lib/http";

export interface ModerationService {
  submitReport(org: string, reporter: Reporter, input: Record<string, unknown>): Promise<{ report: { id: string; status: string }; duplicate: boolean }>;
  listReports(org: string, options: { status?: unknown }): Promise<unknown[]>;
  getReport(org: string, reportId: string): Promise<unknown | null>;
  transitionReport(org: string, actor: string, reportId: string, input: { to: unknown; note?: unknown; expectedRevision?: unknown }): Promise<unknown>;
  addEvidence(org: string, actor: string, reportId: string, input: { kind?: unknown; body?: unknown; mediaId?: unknown }): Promise<{ id: string }>;
  deleteReport(org: string, actor: string, reportId: string): Promise<void>;
  takeModerationAction(org: string, actor: string, input: Record<string, unknown>): Promise<unknown>;
  reverseModerationAction(org: string, actor: string, actionId: string, reason: unknown): Promise<void>;
  listActions(org: string, options: { activeOnly?: boolean }): Promise<unknown[]>;
  listActionsAffecting(org: string, accountId: string): Promise<unknown[]>;
  fileAppeal(org: string, appellant: string, actionId: string, statement: unknown): Promise<{ id: string; status: string }>;
  decideAppeal(org: string, actor: string, appealId: string, input: { decision: unknown; note?: unknown }): Promise<unknown>;
  listAppeals(org: string, status?: unknown): Promise<unknown[]>;
  placeLegalHold(org: string, actor: string, input: Record<string, unknown>): Promise<{ id: string }>;
  releaseLegalHold(org: string, actor: string, holdId: string): Promise<void>;
}

/**
 * Anonymous reporters are keyed by client address. The first X-Forwarded-For hop is
 * used only when the deployment sits behind a trusted proxy that overwrites it.
 */
export function clientKeyFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  const value = forwarded || real || "unknown";
  return value.slice(0, 100);
}

const statusByCode = { rate_limited: 429, legal_hold_active: 409, use_moderation_action_to_resolve: 409 };

async function asModerator(
  authorizer: Authorizer, request: Request, organizationId: string, run: (principal: AuthorizedPrincipal) => Promise<Response>
): Promise<Response> {
  const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
  if (principal instanceof Response) return principal;
  try {
    return await run(principal);
  } catch (error) {
    return domainFailure(error, statusByCode);
  }
}

async function withBody(request: Request, run: (body: Record<string, unknown>) => Promise<Response>): Promise<Response> {
  const body = await readJsonObject(request, 32 * 1024);
  if (body instanceof Response) return body;
  return run(body);
}

export function createModerationHandlers(authorizer: Authorizer, service: ModerationService, clientKey = clientKeyFromRequest) {
  return {
    /** POST reports — members (identity from session) or anonymous. */
    async submitReport(request: Request, organizationId: string): Promise<Response> {
      const principal = await optionalMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(organizationId)) return errorResponse(404, "not_found");
      return withBody(request, async body => {
        try {
          const reporter: Reporter = principal ? { accountId: principal.accountId } : { anonymousKey: clientKey(request) };
          const result = await service.submitReport(organizationId, reporter, body);
          return json({ id: result.report.id, status: result.report.status, duplicate: result.duplicate }, result.duplicate ? 200 : 201);
        } catch (error) {
          return domainFailure(error, statusByCode);
        }
      });
    },

    listReports: (request: Request, organizationId: string) => asModerator(authorizer, request, organizationId, async () =>
      json({ reports: await service.listReports(organizationId, { status: new URL(request.url).searchParams.get("status") ?? undefined }) })),

    getReport: (request: Request, organizationId: string, reportId: string) => asModerator(authorizer, request, organizationId, async () => {
      const report = isUuid(reportId) ? await service.getReport(organizationId, reportId) : null;
      return report ? json(report) : errorResponse(404, "report_not_found");
    }),

    deleteReport: (request: Request, organizationId: string, reportId: string) => asModerator(authorizer, request, organizationId, async principal => {
      await service.deleteReport(organizationId, principal.accountId, reportId);
      return json({ id: reportId, deleted: true });
    }),

    transitionReport: (request: Request, organizationId: string, reportId: string) => asModerator(authorizer, request, organizationId, principal =>
      withBody(request, async body => json(await service.transitionReport(organizationId, principal.accountId, reportId, {
        to: body.to, note: body.note, expectedRevision: body.expectedRevision
      }))))
    ,

    addEvidence: (request: Request, organizationId: string, reportId: string) => asModerator(authorizer, request, organizationId, principal =>
      withBody(request, async body => json(await service.addEvidence(organizationId, principal.accountId, reportId, {
        kind: body.kind, body: body.body, mediaId: body.mediaId
      }), 201))),

    listActions: (request: Request, organizationId: string) => asModerator(authorizer, request, organizationId, async () =>
      json({ actions: await service.listActions(organizationId, { activeOnly: new URL(request.url).searchParams.get("active") === "true" }) })),

    takeAction: (request: Request, organizationId: string) => asModerator(authorizer, request, organizationId, principal =>
      withBody(request, async body => json(await service.takeModerationAction(organizationId, principal.accountId, body), 201))),

    reverseAction: (request: Request, organizationId: string, actionId: string) => asModerator(authorizer, request, organizationId, principal =>
      withBody(request, async body => {
        await service.reverseModerationAction(organizationId, principal.accountId, actionId, body.reason);
        return json({ id: actionId, reversed: true });
      })),

    /** GET my actions — the affected member sees what they can appeal. */
    async myActions(request: Request, organizationId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      return json({ actions: await service.listActionsAffecting(organizationId, principal.accountId) });
    },

    /** POST actions/{actionId}/appeals — only the affected account, identity from session. */
    async fileAppeal(request: Request, organizationId: string, actionId: string): Promise<Response> {
      const principal = await requireMember(authorizer, request, organizationId);
      if (principal instanceof Response) return principal;
      return withBody(request, async body => {
        try {
          return json(await service.fileAppeal(organizationId, principal.accountId, actionId, body.statement), 201);
        } catch (error) {
          return domainFailure(error, statusByCode);
        }
      });
    },

    listAppeals: (request: Request, organizationId: string) => asModerator(authorizer, request, organizationId, async () =>
      json({ appeals: await service.listAppeals(organizationId, new URL(request.url).searchParams.get("status") ?? "open") })),

    decideAppeal: (request: Request, organizationId: string, appealId: string) => asModerator(authorizer, request, organizationId, principal =>
      withBody(request, async body => json(await service.decideAppeal(organizationId, principal.accountId, appealId, {
        decision: body.decision, note: body.note
      })))),

    placeHold: (request: Request, organizationId: string) => asModerator(authorizer, request, organizationId, principal =>
      withBody(request, async body => json(await service.placeLegalHold(organizationId, principal.accountId, body), 201))),

    releaseHold: (request: Request, organizationId: string, holdId: string) => asModerator(authorizer, request, organizationId, async principal => {
      await service.releaseLegalHold(organizationId, principal.accountId, holdId);
      return json({ id: holdId, released: true });
    })
  };
}
