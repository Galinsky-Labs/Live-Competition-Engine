import type * as Audience from "@live-competition-engine/db/audience";
import {
  domainFailure,
  errorResponse,
  isUuid,
  json,
  readJsonObject,
  requireAction,
  requireMember,
  type Authorizer
} from "../../../../../../../lib/http";

/** Storage functions the audience handlers depend on (Postgres implementations in production). */
export type AudienceServices = Pick<typeof Audience,
  | "getAudienceSettings" | "updateAudienceSettings" | "acceptAudienceTerms"
  | "addReaction" | "getReactionCounts"
  | "postChatMessage" | "listChatMessages" | "moderateChatMessage" | "muteAccount" | "revokeMute"
  | "listBlockedTerms" | "addBlockedTerm" | "removeBlockedTerm"
  | "submitQuestion" | "upvoteQuestion" | "decideQuestion" | "listQuestions"
  | "createPoll" | "transitionPoll" | "votePoll" | "getPoll" | "listPolls">;

type Scope = { organizationId: string; competitionId: string };

async function run(work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    return domainFailure(error);
  }
}

/**
 * Viewer resolution for reads: event managers (event.manage for this competition)
 * see moderated items; anyone else must be an active member.
 */
async function viewer(authorizer: Authorizer, request: Request, scope: Scope) {
  if (!isUuid(scope.organizationId) || !isUuid(scope.competitionId)) return errorResponse(404, "not_found");
  const manager = await requireAction(authorizer, request, "event.manage", scope);
  if (!(manager instanceof Response)) return { accountId: manager.accountId, isManager: true };
  if (manager.status === 401) return manager;
  const member = await requireMember(authorizer, request, scope.organizationId);
  if (member instanceof Response) return member;
  return { accountId: member.accountId, isManager: false };
}

const member = async (authorizer: Authorizer, request: Request, scope: Scope) => {
  if (!isUuid(scope.competitionId)) return errorResponse(404, "not_found");
  return requireMember(authorizer, request, scope.organizationId);
};

const manager = (authorizer: Authorizer, request: Request, scope: Scope) =>
  requireAction(authorizer, request, "event.manage", scope);

export function createAudienceHandlers(authorizer: Authorizer, services: AudienceServices) {
  return {
    async getSettings(request: Request, scope: Scope) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      return run(async () => json(await services.getAudienceSettings(scope.organizationId, scope.competitionId)));
    },

    async putSettings(request: Request, scope: Scope) {
      const principal = await manager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      if (!Number.isInteger(body.expectedRevision)) return errorResponse(400, "invalid_revision");
      return run(async () => json(await services.updateAudienceSettings(
        scope.organizationId, scope.competitionId, principal.accountId, body, body.expectedRevision as number)));
    },

    async postConsent(request: Request, scope: Scope) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await services.acceptAudienceTerms(
        scope.organizationId, scope.competitionId, principal.accountId, body.termsVersion), 201));
    },

    async getReactions(request: Request, scope: Scope) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const performanceId = new URL(request.url).searchParams.get("performanceId");
      if (!isUuid(performanceId)) return errorResponse(400, "invalid_performance");
      return run(async () => json({ performanceId, counts: await services.getReactionCounts(scope.organizationId, scope.competitionId, performanceId) }));
    },

    async postReaction(request: Request, scope: Scope) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      if (!isUuid(body.performanceId)) return errorResponse(400, "invalid_performance");
      const performanceId = body.performanceId;
      return run(async () => json({ performanceId, counts: await services.addReaction(
        scope.organizationId, scope.competitionId, performanceId, principal.accountId, body.kind) }, 201));
    },

    async getChat(request: Request, scope: Scope) {
      const who = await viewer(authorizer, request, scope);
      if (who instanceof Response) return who;
      const before = new URL(request.url).searchParams.get("before");
      const beforeDate = before ? new Date(before) : undefined;
      if (beforeDate && Number.isNaN(beforeDate.getTime())) return errorResponse(400, "invalid_cursor");
      return run(async () => json({ messages: await services.listChatMessages(scope.organizationId, scope.competitionId, {
        includeModerated: who.isManager, ...(beforeDate ? { before: beforeDate } : {})
      }) }));
    },

    async postChat(request: Request, scope: Scope) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 8192);
      if (body instanceof Response) return body;
      return run(async () => json(await services.postChatMessage(scope.organizationId, scope.competitionId, principal.accountId, body.body), 201));
    },

    async patchChatMessage(request: Request, scope: Scope, messageId: string) {
      const principal = await manager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(messageId)) return errorResponse(404, "message_not_found");
      const body = await readJsonObject(request, 2048);
      if (body instanceof Response) return body;
      return run(async () => json(await services.moderateChatMessage(
        scope.organizationId, scope.competitionId, messageId, principal.accountId, body.action, body.reason)));
    },

    async postMute(request: Request, scope: Scope) {
      const principal = await manager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 2048);
      if (body instanceof Response) return body;
      if (!isUuid(body.accountId)) return errorResponse(400, "invalid_account");
      const target = body.accountId;
      return run(async () => json(await services.muteAccount(
        scope.organizationId, scope.competitionId, target, principal.accountId, body.durationSeconds, body.reason), 201));
    },

    async deleteMute(request: Request, scope: Scope, muteId: string) {
      const principal = await manager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(muteId)) return errorResponse(404, "mute_not_found");
      return run(async () => {
        await services.revokeMute(scope.organizationId, scope.competitionId, muteId, principal.accountId);
        return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
      });
    },

    async getQuestions(request: Request, scope: Scope) {
      const who = await viewer(authorizer, request, scope);
      if (who instanceof Response) return who;
      const status = new URL(request.url).searchParams.get("status");
      if (status !== null && status !== "open" && status !== "answered" && status !== "dismissed") return errorResponse(400, "invalid_status");
      return run(async () => json({ questions: await services.listQuestions(scope.organizationId, scope.competitionId, {
        viewerAccountId: who.accountId, ...(status ? { status } : {})
      }) }));
    },

    async postQuestion(request: Request, scope: Scope) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      return run(async () => json(await services.submitQuestion(scope.organizationId, scope.competitionId, principal.accountId, body.body), 201));
    },

    async postUpvote(request: Request, scope: Scope, questionId: string) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(questionId)) return errorResponse(404, "question_not_found");
      return run(async () => json(await services.upvoteQuestion(scope.organizationId, scope.competitionId, questionId, principal.accountId)));
    },

    async patchQuestion(request: Request, scope: Scope, questionId: string) {
      const principal = await manager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(questionId)) return errorResponse(404, "question_not_found");
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await services.decideQuestion(scope.organizationId, scope.competitionId, questionId, principal.accountId, body.status)));
    },

    async getPolls(request: Request, scope: Scope) {
      const who = await viewer(authorizer, request, scope);
      if (who instanceof Response) return who;
      return run(async () => json({ polls: await services.listPolls(scope.organizationId, scope.competitionId, who) }));
    },

    async postPoll(request: Request, scope: Scope) {
      const principal = await manager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 8192);
      if (body instanceof Response) return body;
      return run(async () => json(await services.createPoll(scope.organizationId, scope.competitionId, principal.accountId, body), 201));
    },

    async getPollOne(request: Request, scope: Scope, pollId: string) {
      const who = await viewer(authorizer, request, scope);
      if (who instanceof Response) return who;
      if (!isUuid(pollId)) return errorResponse(404, "poll_not_found");
      return run(async () => json(await services.getPoll(scope.organizationId, scope.competitionId, pollId, who)));
    },

    async patchPoll(request: Request, scope: Scope, pollId: string) {
      const principal = await manager(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(pollId)) return errorResponse(404, "poll_not_found");
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await services.transitionPoll(
        scope.organizationId, scope.competitionId, pollId, principal.accountId, body.action, body.expectedRevision)));
    },

    async postPollVote(request: Request, scope: Scope, pollId: string) {
      const principal = await member(authorizer, request, scope);
      if (principal instanceof Response) return principal;
      if (!isUuid(pollId)) return errorResponse(404, "poll_not_found");
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await services.votePoll(scope.organizationId, scope.competitionId, pollId, principal.accountId, body.optionId), 201));
    }
  };
}

/** Tenant-wide blocked-term list (tenant.manage). */
export function createBlockedTermHandlers(authorizer: Authorizer, services: Pick<AudienceServices, "listBlockedTerms" | "addBlockedTerm" | "removeBlockedTerm">) {
  const admin = (request: Request, organizationId: string) => requireAction(authorizer, request, "tenant.manage", { organizationId });
  return {
    async list(request: Request, organizationId: string) {
      const principal = await admin(request, organizationId);
      if (principal instanceof Response) return principal;
      return run(async () => json({ terms: await services.listBlockedTerms(organizationId) }));
    },
    async add(request: Request, organizationId: string) {
      const principal = await admin(request, organizationId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 1024);
      if (body instanceof Response) return body;
      return run(async () => json(await services.addBlockedTerm(organizationId, principal.accountId, body.term), 201));
    },
    async remove(request: Request, organizationId: string, termId: string) {
      const principal = await admin(request, organizationId);
      if (principal instanceof Response) return principal;
      if (!isUuid(termId)) return errorResponse(404, "blocked_term_not_found");
      return run(async () => {
        await services.removeBlockedTerm(organizationId, principal.accountId, termId);
        return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
      });
    }
  };
}
