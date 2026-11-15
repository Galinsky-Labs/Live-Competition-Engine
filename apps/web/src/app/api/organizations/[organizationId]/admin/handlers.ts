import type { AuthorizedPrincipal } from "@live-competition-engine/auth";
import type { SectionResult, BillingSummary, ModerationOverviewCounts } from "@live-competition-engine/db/admin-overview";
import type { InvitationCreated, MemberSummary, ShowOverview, Venue } from "@live-competition-engine/db/tenant-admin";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  authFailure,
  type Authorizer
} from "../../../../../lib/http";

export interface TenantAdminService {
  listMembers(organizationId: string, options?: { limit?: number; offset?: number }): Promise<MemberSummary[]>;
  setMembershipStatus(organizationId: string, actor: string, accountId: string, status: "active" | "suspended"): Promise<void>;
  grantTenantRole(organizationId: string, actor: string, accountId: string, input: { role?: unknown; competitionId?: unknown; expiresAt?: unknown }): Promise<{ id: string }>;
  revokeTenantRole(organizationId: string, actor: string, grantId: string): Promise<void>;
  createInvitation(organizationId: string, actor: string, input: { email: unknown; initialRole?: unknown; ttlMs?: unknown }): Promise<InvitationCreated>;
  revokeInvitation(organizationId: string, actor: string, invitationId: string): Promise<void>;
  listInvitations(organizationId: string): Promise<unknown[]>;
  acceptInvitation(organizationId: string, accountId: string, token: unknown): Promise<{ membershipCreated: boolean; roleGrantId: string | null }>;
  listVenues(organizationId: string, includeArchived?: boolean): Promise<Venue[]>;
  createVenue(organizationId: string, actor: string, input: Record<string, unknown>): Promise<Venue>;
  updateVenue(organizationId: string, actor: string, venueId: string, input: Record<string, unknown>): Promise<Venue>;
  archiveVenue(organizationId: string, actor: string, venueId: string): Promise<void>;
  assignCompetitionVenue(organizationId: string, actor: string, competitionId: string, venueId: string | null): Promise<void>;
  showOverview(organizationId: string): Promise<ShowOverview>;
  billingSection(organizationId: string): Promise<SectionResult<BillingSummary>>;
  moderationSection(organizationId: string): Promise<SectionResult<ModerationOverviewCounts>>;
}

type Guarded = (principal: AuthorizedPrincipal) => Promise<Response>;

/** Authorize tenant.manage, then run the action, mapping DomainErrors to HTTP. */
async function asTenantManager(authorizer: Authorizer, request: Request, organizationId: string, run: Guarded): Promise<Response> {
  const principal = await requireAction(authorizer, request, "tenant.manage", { organizationId });
  if (principal instanceof Response) return principal;
  try {
    return await run(principal);
  } catch (error) {
    return domainFailure(error);
  }
}

export function createTenantAdminHandlers(authorizer: Authorizer, service: TenantAdminService) {
  return {
    listMembers: (request: Request, organizationId: string) =>
      asTenantManager(authorizer, request, organizationId, async () => {
        const url = new URL(request.url);
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) return errorResponse(400, "invalid_pagination");
        return json({ members: await service.listMembers(organizationId, { limit, offset }) });
      }),

    setMemberStatus: (request: Request, organizationId: string, accountId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        if (!isUuid(accountId)) return errorResponse(404, "member_not_found");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        if (body.status !== "active" && body.status !== "suspended") return errorResponse(400, "invalid_membership_status");
        await service.setMembershipStatus(organizationId, principal.accountId, accountId, body.status);
        return json({ accountId, status: body.status });
      }),

    grantRole: (request: Request, organizationId: string, accountId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        if (!isUuid(accountId)) return errorResponse(404, "member_not_found");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        const grant = await service.grantTenantRole(organizationId, principal.accountId, accountId, {
          role: body.role, competitionId: body.competitionId, expiresAt: body.expiresAt
        });
        return json(grant, 201);
      }),

    revokeRole: (request: Request, organizationId: string, grantId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        if (!isUuid(grantId)) return errorResponse(404, "role_grant_not_found");
        await service.revokeTenantRole(organizationId, principal.accountId, grantId);
        return json({ id: grantId, revoked: true });
      }),

    listInvitations: (request: Request, organizationId: string) =>
      asTenantManager(authorizer, request, organizationId, async () => json({ invitations: await service.listInvitations(organizationId) })),

    createInvitation: (request: Request, organizationId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        const invitation = await service.createInvitation(organizationId, principal.accountId, {
          email: body.email, initialRole: body.initialRole, ttlMs: body.ttlMs
        });
        return json(invitation, 201);
      }),

    revokeInvitation: (request: Request, organizationId: string, invitationId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        if (!isUuid(invitationId)) return errorResponse(404, "invitation_not_found");
        await service.revokeInvitation(organizationId, principal.accountId, invitationId);
        return json({ id: invitationId, status: "revoked" });
      }),

    /** Any authenticated account may try; membership is not required (it is what gets created). */
    async acceptInvitation(request: Request, organizationId: string): Promise<Response> {
      if (!isUuid(organizationId)) return errorResponse(404, "not_found");
      let accountId: string;
      try {
        accountId = (await authorizer.authorize(request.headers.get("authorization"))).accountId;
      } catch (error) {
        return authFailure(error);
      }
      const body = await readJsonObject(request);
      if (body instanceof Response) return body;
      try {
        return json(await service.acceptInvitation(organizationId, accountId, body.token));
      } catch (error) {
        return domainFailure(error, { invitation_expired: 410 });
      }
    },

    listVenues: (request: Request, organizationId: string) =>
      asTenantManager(authorizer, request, organizationId, async () => {
        const includeArchived = new URL(request.url).searchParams.get("includeArchived") === "true";
        return json({ venues: await service.listVenues(organizationId, includeArchived) });
      }),

    createVenue: (request: Request, organizationId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        return json(await service.createVenue(organizationId, principal.accountId, body), 201);
      }),

    updateVenue: (request: Request, organizationId: string, venueId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        if (!isUuid(venueId)) return errorResponse(404, "venue_not_found");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        return json(await service.updateVenue(organizationId, principal.accountId, venueId, body));
      }),

    archiveVenue: (request: Request, organizationId: string, venueId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        if (!isUuid(venueId)) return errorResponse(404, "venue_not_found");
        await service.archiveVenue(organizationId, principal.accountId, venueId);
        return json({ id: venueId, archived: true });
      }),

    assignVenue: (request: Request, organizationId: string, competitionId: string) =>
      asTenantManager(authorizer, request, organizationId, async principal => {
        if (!isUuid(competitionId)) return errorResponse(404, "competition_not_found");
        const body = await readJsonObject(request);
        if (body instanceof Response) return body;
        const venueId = body.venueId ?? null;
        if (venueId !== null && !isUuid(venueId)) return errorResponse(400, "invalid_venue_id");
        await service.assignCompetitionVenue(organizationId, principal.accountId, competitionId, venueId as string | null);
        return json({ competitionId, venueId });
      }),

    overview: (request: Request, organizationId: string) =>
      asTenantManager(authorizer, request, organizationId, async () => {
        const [shows, moderation, billing] = await Promise.all([
          service.showOverview(organizationId),
          service.moderationSection(organizationId),
          service.billingSection(organizationId)
        ]);
        return json({ shows, moderation, billing });
      })
  };
}
