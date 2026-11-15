import { createHmac, randomBytes } from "node:crypto";
import {
  answerPoll, auditVoteWindow, castVote, closePoll, createPoll, createVoteWindow, listAudienceMessages, listPolls, listVoteWindows,
  moderateAudienceMessage, postAudienceMessage, react, reactionCounts, setVoteWindowStatus, voidVotesByNetwork, voteResults
} from "@live-competition-engine/db/audience-voting";
import { getPublicEvent } from "@live-competition-engine/db/events";
import { HttpError } from "@/lib/http";
import { canManageEvent, manageEvent, signedIn } from "../access";
import { json, type RouteContext, type RouteDef } from "../router";

const processSecret = randomBytes(32).toString("hex");
/** Daily-rotating key for network fingerprints: hashes are comparable within a day and unlinkable across days. */
export function networkDaySecret(now = new Date()) {
  return createHmac("sha256", process.env.VOTE_NETWORK_SECRET || processSecret).update(now.toISOString().slice(0, 10)).digest("hex");
}
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && forwarded.length <= 64 ? forwarded : null;
}

async function visible(ctx: RouteContext) {
  if (await canManageEvent(ctx)) return true;
  if (!(await getPublicEvent(ctx.organizationId, ctx.params.eventId!))) throw new HttpError(404, "event_not_found");
  return false;
}

export const audienceVotingRoutes: RouteDef[] = [
  { method: "GET", pattern: ":eventId/reactions", handler: async ctx => { await visible(ctx); return json(await reactionCounts(ctx.organizationId, ctx.params.eventId!, ctx.url.searchParams.get("performanceId") ?? undefined)); } },
  {
    method: "POST", pattern: ":eventId/reactions", handler: async ctx => {
      const principal = await signedIn(ctx);
      const body = await ctx.body();
      return json(await react(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.reaction, body.performanceId, body.consent), 201);
    }
  },
  { method: "GET", pattern: ":eventId/messages", handler: async ctx => json(await listAudienceMessages(ctx.organizationId, ctx.params.eventId!, await visible(ctx))) },
  {
    method: "POST", pattern: ":eventId/messages", handler: async ctx => {
      const principal = await signedIn(ctx);
      const body = await ctx.body();
      return json(await postAudienceMessage(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.kind, body.body, body.consent), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/messages/moderate", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await moderateAudienceMessage(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.messageId, body.status));
    }
  },
  { method: "GET", pattern: ":eventId/polls", handler: async ctx => { await visible(ctx); return json(await listPolls(ctx.organizationId, ctx.params.eventId!)); } },
  {
    method: "POST", pattern: ":eventId/polls", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await createPoll(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.question, body.options), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/polls/:pollId/answer", handler: async ctx => {
      const principal = await signedIn(ctx);
      const body = await ctx.body();
      return json(await answerPoll(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.pollId, body.optionIndex, body.consent), 201);
    }
  },
  { method: "POST", pattern: ":eventId/polls/:pollId/close", handler: async ctx => { const p = await manageEvent(ctx); return json(await closePoll(ctx.organizationId, ctx.params.eventId!, p.accountId, ctx.params.pollId!)); } },
  { method: "GET", pattern: ":eventId/vote-windows", handler: async ctx => { await visible(ctx); return json(await listVoteWindows(ctx.organizationId, ctx.params.eventId!)); } },
  {
    method: "POST", pattern: ":eventId/vote-windows", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await createVoteWindow(ctx.organizationId, ctx.params.eventId!, principal.accountId, await ctx.body()), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/vote-windows/:windowId/open", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await setVoteWindowStatus(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.windowId, "open", (await ctx.body()).expectedRevision));
    }
  },
  {
    method: "POST", pattern: ":eventId/vote-windows/:windowId/close", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await setVoteWindowStatus(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.windowId, "closed", (await ctx.body()).expectedRevision));
    }
  },
  {
    method: "POST", pattern: ":eventId/vote-windows/:windowId/votes", handler: async ctx => {
      const principal = await signedIn(ctx);
      const body = await ctx.body();
      return json(await castVote(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.windowId, body.entryId, { ip: clientIp(ctx.request), daySecret: networkDaySecret() }), 201);
    }
  },
  { method: "GET", pattern: ":eventId/vote-windows/:windowId/results", handler: async ctx => json(await voteResults(ctx.organizationId, ctx.params.eventId!, ctx.params.windowId, await visible(ctx))) },
  { method: "GET", pattern: ":eventId/vote-windows/:windowId/audit", handler: async ctx => { await manageEvent(ctx); return json(await auditVoteWindow(ctx.organizationId, ctx.params.eventId!, ctx.params.windowId)); } },
  {
    method: "POST", pattern: ":eventId/vote-windows/:windowId/void", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await voidVotesByNetwork(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.windowId, body.networkHash, body.reason));
    }
  }
];
