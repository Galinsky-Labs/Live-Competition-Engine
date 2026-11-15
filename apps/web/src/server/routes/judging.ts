import { normalizeEmail } from "@live-competition-engine/auth/credentials";
import {
  appealCritique, correctScores, critiqueHistory, declareRecusal, inviteJudge, judgeForAccount, listAppeals, listPanel,
  listRecusals, listSheets, removeJudge, resolveAppeal, respondToJudgeInvite, reviseCritique, stageStandings, submitScores,
  visibleCritiques, writeCritique
} from "@live-competition-engine/db/judging";
import { getSqlClient } from "@live-competition-engine/db";
import { HttpError } from "@/lib/http";
import { actOnEvent, canManageEvent, manageEvent, optionalSignedIn, signedIn } from "../access";
import { json, type RouteDef } from "../router";
import { standingsSource } from "./stages";

standingsSource.compute = (organizationId, eventId, stageId) => stageStandings(organizationId, eventId, stageId);

const judge = async (ctx: Parameters<RouteDef["handler"]>[0]) => {
  const principal = await actOnEvent(ctx, "judging.score");
  return { principal, judge: await judgeForAccount(getSqlClient(), ctx.organizationId, ctx.params.eventId!, principal.accountId) };
};

export const judgingRoutes: RouteDef[] = [
  { method: "GET", pattern: ":eventId/judges", handler: async ctx => { await manageEvent(ctx); return json(await listPanel(ctx.organizationId, ctx.params.eventId!)); } },
  {
    method: "POST", pattern: ":eventId/judges", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      const email = normalizeEmail(body.email);
      if (!email) throw new HttpError(400, "email_invalid");
      return json(await inviteJudge(ctx.organizationId, ctx.params.eventId!, principal.accountId, email, body.displayName, body.panel), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/judges/respond", handler: async ctx => {
      const principal = await signedIn(ctx);
      return json(await respondToJudgeInvite(ctx.organizationId, ctx.params.eventId!, principal.accountId, (await ctx.body()).accept === true));
    }
  },
  {
    method: "POST", pattern: ":eventId/judges/:judgeId/remove", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await removeJudge(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.judgeId, (await ctx.body()).reason));
    }
  },
  {
    method: "POST", pattern: ":eventId/recusals", handler: async ctx => {
      const body = await ctx.body();
      if (await canManageEvent(ctx) && typeof body.judgeId === "string") {
        const principal = await manageEvent(ctx);
        return json(await declareRecusal(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.judgeId, body.entryId, body.reason), 201);
      }
      const { principal, judge: me } = await judge(ctx);
      return json(await declareRecusal(ctx.organizationId, ctx.params.eventId!, principal.accountId, me.judgeId, body.entryId, body.reason), 201);
    }
  },
  { method: "GET", pattern: ":eventId/recusals", handler: async ctx => { await manageEvent(ctx); return json(await listRecusals(ctx.organizationId, ctx.params.eventId!)); } },
  {
    method: "POST", pattern: ":eventId/performances/:performanceId/scores", handler: async ctx => {
      const { principal } = await judge(ctx);
      return json(await submitScores(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.performanceId, (await ctx.body()).scores), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/score-sheets/:sheetId/correct", handler: async ctx => {
      const { principal } = await judge(ctx);
      const body = await ctx.body();
      return json(await correctScores(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.sheetId, body.scores, body.reason), 201);
    }
  },
  {
    method: "GET", pattern: ":eventId/stages/:stageId/score-sheets", handler: async ctx => {
      if (await canManageEvent(ctx)) return json(await listSheets(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId!));
      const { judge: me } = await judge(ctx);
      return json(await listSheets(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId!, me.judgeId));
    }
  },
  { method: "GET", pattern: ":eventId/stages/:stageId/standings", handler: async ctx => { await manageEvent(ctx); return json(await stageStandings(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId!)); } },
  {
    method: "POST", pattern: ":eventId/performances/:performanceId/critiques", handler: async ctx => {
      const { principal } = await judge(ctx);
      const body = await ctx.body();
      return json(await writeCritique(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.performanceId, body.body, body.visibility), 201);
    }
  },
  {
    method: "GET", pattern: ":eventId/critiques", handler: async ctx => {
      const producer = await canManageEvent(ctx);
      const viewer = await optionalSignedIn(ctx);
      return json(await visibleCritiques(ctx.organizationId, ctx.params.eventId!, { accountId: viewer?.accountId ?? null, producer }));
    }
  },
  {
    method: "PATCH", pattern: ":eventId/critiques/:critiqueId", handler: async ctx => {
      const body = await ctx.body();
      if (await canManageEvent(ctx)) {
        const principal = await manageEvent(ctx);
        return json(await reviseCritique(ctx.organizationId, ctx.params.eventId!, principal.accountId, "producer", ctx.params.critiqueId, body.expectedRevision, body));
      }
      const { principal } = await judge(ctx);
      return json(await reviseCritique(ctx.organizationId, ctx.params.eventId!, principal.accountId, "author", ctx.params.critiqueId, body.expectedRevision, body));
    }
  },
  { method: "GET", pattern: ":eventId/critiques/:critiqueId/history", handler: async ctx => { await manageEvent(ctx); return json(await critiqueHistory(ctx.organizationId, ctx.params.critiqueId!)); } },
  {
    method: "POST", pattern: ":eventId/critiques/:critiqueId/appeal", handler: async ctx => {
      const principal = await signedIn(ctx);
      return json(await appealCritique(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.critiqueId, (await ctx.body()).reason), 201);
    }
  },
  { method: "GET", pattern: ":eventId/appeals", handler: async ctx => { await manageEvent(ctx); return json(await listAppeals(ctx.organizationId, ctx.params.eventId!)); } },
  {
    method: "POST", pattern: ":eventId/appeals/:appealId/resolve", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await resolveAppeal(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.appealId, body.outcome, body.resolution));
    }
  }
];
