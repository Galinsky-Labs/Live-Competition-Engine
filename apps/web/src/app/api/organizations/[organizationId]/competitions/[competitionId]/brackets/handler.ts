import type { MatchAction } from "@live-competition-engine/domain/brackets";
import type { BracketView, MatchView } from "@live-competition-engine/db/brackets";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  type Authorizer
} from "../../../../../../../lib/http";
import { etag, parseIfMatch } from "../../../../../../../lib/revision";

export interface BracketDeps {
  createTeam(organizationId: string, competitionId: string, actorAccountId: string, input: { name: unknown; participantIds: unknown }): Promise<{ id: string; name: string; participantIds: string[] }>;
  listTeams(organizationId: string, competitionId: string): Promise<unknown[]>;
  createBracket(organizationId: string, competitionId: string, actorAccountId: string, input: { stageId?: unknown; sides: unknown; idempotencyKey: unknown }): Promise<BracketView>;
  listBrackets(organizationId: string, competitionId: string): Promise<unknown[]>;
  getBracket(organizationId: string, competitionId: string, bracketId: string): Promise<BracketView | null>;
  getPublicBracket(organizationId: string, competitionId: string, bracketId: string): Promise<BracketView | null>;
  createMatch(organizationId: string, competitionId: string, actorAccountId: string, input: { sides: unknown }): Promise<MatchView>;
  actOnMatch(organizationId: string, competitionId: string, matchId: string, actorAccountId: string, input: { action: MatchAction; winnerSlot?: number | null; reason?: string | null }, expectedRevision: number): Promise<MatchView>;
  isAction(value: unknown): value is MatchAction;
}

/** Head-to-head handlers (event.manage with competitionId). The service enforces the `brackets` flag. */
export function createBracketHandlers(authorizer: Authorizer, deps: BracketDeps) {
  const manage = (request: Request, organizationId: string, competitionId: string) =>
    requireAction(authorizer, request, "event.manage", { organizationId, competitionId });

  const run = async (work: () => Promise<Response>) => {
    try {
      return await work();
    } catch (error) {
      return domainFailure(error);
    }
  };

  return {
    async listTeams(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      return json({ teams: await deps.listTeams(organizationId, competitionId) });
    },

    async createTeam(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await deps.createTeam(organizationId, competitionId, principal.accountId,
        { name: body.name, participantIds: body.participantIds }), 201));
    },

    async listBrackets(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      return run(async () => json({ brackets: await deps.listBrackets(organizationId, competitionId) }));
    },

    /** POST { sides: [{entryId|teamId, seed}], stageId?, idempotencyKey } */
    async createBracket(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 64 * 1024);
      if (body instanceof Response) return body;
      return run(async () => {
        const bracket = await deps.createBracket(organizationId, competitionId, principal.accountId, {
          stageId: body.stageId, sides: body.sides, idempotencyKey: body.idempotencyKey ?? request.headers.get("idempotency-key")
        });
        return json(bracket, bracket.replayed ? 200 : 201);
      });
    },

    async getBracket(request: Request, organizationId: string, competitionId: string, bracketId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      if (!isUuid(bracketId)) return errorResponse(404, "bracket_not_found");
      return run(async () => {
        const bracket = await deps.getBracket(organizationId, competitionId, bracketId);
        return bracket ? json(bracket) : errorResponse(404, "bracket_not_found");
      });
    },

    async publicGetBracket(_request: Request, organizationId: string, competitionId: string, bracketId: string): Promise<Response> {
      if (!isUuid(organizationId) || !isUuid(competitionId) || !isUuid(bracketId)) return errorResponse(404, "bracket_not_found");
      return run(async () => {
        const bracket = await deps.getPublicBracket(organizationId, competitionId, bracketId);
        return bracket ? json(bracket) : errorResponse(404, "bracket_not_found");
      });
    },

    async createMatch(request: Request, organizationId: string, competitionId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 16 * 1024);
      if (body instanceof Response) return body;
      return run(async () => {
        const match = await deps.createMatch(organizationId, competitionId, principal.accountId, { sides: body.sides });
        return json(match, 201, etag(match.revision));
      });
    },

    /** POST { action: start|decide|void, winnerSlot?, reason? } with If-Match: match revision. */
    async actOnMatch(request: Request, organizationId: string, competitionId: string, matchId: string): Promise<Response> {
      const principal = await manage(request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      if (!isUuid(matchId)) return errorResponse(404, "match_not_found");
      const expected = parseIfMatch(request);
      if (expected === "invalid") return errorResponse(400, "invalid_if_match");
      if (expected === null) return errorResponse(428, "if_match_required");
      const body = await readJsonObject(request, 4 * 1024);
      if (body instanceof Response) return body;
      if (!deps.isAction(body.action)) return errorResponse(400, "invalid_match_action");
      if (body.winnerSlot !== undefined && !Number.isInteger(body.winnerSlot)) return errorResponse(400, "invalid_match_winner");
      if (body.reason !== undefined && typeof body.reason !== "string") return errorResponse(400, "invalid_reason");
      return run(async () => {
        const match = await deps.actOnMatch(organizationId, competitionId, matchId, principal.accountId, {
          action: body.action as MatchAction,
          ...(body.winnerSlot !== undefined ? { winnerSlot: body.winnerSlot as number } : {}),
          ...(typeof body.reason === "string" ? { reason: body.reason } : {})
        }, expected);
        return json(match, 200, etag(match.revision));
      });
    }
  };
}
