import type { Standing } from "@live-competition-engine/engine";
import {
  addEntrant, advanceStage, createStage, decideMatchup, generateBracket, listEntrants, listMatchups, listStageEntrants,
  listStages, setEntrantStatus, setStageEntrants, transitionStage, updateStage
} from "@live-competition-engine/db/stages";
import { getPublicEvent } from "@live-competition-engine/db/events";
import { HttpError } from "@/lib/http";
import { canManageEvent, manageEvent } from "../access";
import { json, type RouteDef, type RouteContext } from "../router";

async function readable(ctx: RouteContext) {
  if (await canManageEvent(ctx)) return;
  if (!(await getPublicEvent(ctx.organizationId, ctx.params.eventId!))) throw new HttpError(404, "event_not_found");
}

/** Standings provider; LC-20 scoring replaces the default (explicit producer ranking). */
export const standingsSource: { compute: (organizationId: string, eventId: string, stageId: string) => Promise<Standing[] | null> } = {
  compute: async () => null
};

function rankingToStandings(ranking: unknown): Standing[] {
  if (!Array.isArray(ranking)) return [];
  return ranking.filter((id): id is string => typeof id === "string").map((entryId, index) => ({ entryId, score: null, rank: index + 1 }));
}

const stageTransition = (to: "live" | "completed" | "cancelled"): RouteDef["handler"] => async ctx => {
  const principal = await manageEvent(ctx);
  const body = await ctx.body();
  return json(await transitionStage(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId, principal.accountId, to, body.expectedRevision));
};

export const stageRoutes: RouteDef[] = [
  {
    method: "GET", pattern: ":eventId/entrants", handler: async ctx => {
      await readable(ctx);
      const manager = await canManageEvent(ctx);
      const entrants = await listEntrants(ctx.organizationId, ctx.params.eventId!);
      return json(manager ? entrants : entrants.filter(e => e.status === "approved").map(({ entryId, displayName, kind, members }) => ({ entryId, displayName, kind, members })));
    }
  },
  {
    method: "POST", pattern: ":eventId/entrants", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await addEntrant(ctx.organizationId, ctx.params.eventId!, principal.accountId, { displayName: body.displayName, kind: body.kind, members: body.members }), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/entrants/:entryId/status", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await setEntrantStatus(ctx.organizationId, ctx.params.eventId!, ctx.params.entryId, principal.accountId, body.status, body.reason));
    }
  },
  {
    method: "GET", pattern: ":eventId/stages", handler: async ctx => {
      await readable(ctx);
      return json(await listStages(ctx.organizationId, ctx.params.eventId!));
    }
  },
  {
    method: "POST", pattern: ":eventId/stages", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await createStage(ctx.organizationId, ctx.params.eventId!, principal.accountId, await ctx.body()), 201);
    }
  },
  {
    method: "PATCH", pattern: ":eventId/stages/:stageId", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const { expectedRevision, ...patch } = await ctx.body();
      return json(await updateStage(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId, principal.accountId, expectedRevision, patch));
    }
  },
  { method: "POST", pattern: ":eventId/stages/:stageId/start", handler: stageTransition("live") },
  { method: "POST", pattern: ":eventId/stages/:stageId/complete", handler: stageTransition("completed") },
  { method: "POST", pattern: ":eventId/stages/:stageId/cancel", handler: stageTransition("cancelled") },
  {
    method: "GET", pattern: ":eventId/stages/:stageId/entrants", handler: async ctx => {
      await readable(ctx);
      return json(await listStageEntrants(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId!));
    }
  },
  {
    method: "PUT", pattern: ":eventId/stages/:stageId/entrants", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json({ count: await setStageEntrants(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId, principal.accountId, body.entryIds) });
    }
  },
  {
    method: "POST", pattern: ":eventId/stages/:stageId/advance", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      const computed = await standingsSource.compute(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId!);
      const standings = Array.isArray(body.ranking) ? rankingToStandings(body.ranking) : computed ?? [];
      const manual = Array.isArray(body.selection) ? body.selection.filter((x): x is string => typeof x === "string") : [];
      return json({ advancing: await advanceStage(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId, body.toStageId, principal.accountId, standings, manual) });
    }
  },
  {
    method: "GET", pattern: ":eventId/stages/:stageId/matchups", handler: async ctx => {
      await readable(ctx);
      return json(await listMatchups(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId!));
    }
  },
  {
    method: "POST", pattern: ":eventId/stages/:stageId/bracket", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await generateBracket(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId, principal.accountId), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/matchups/:matchupId/decide", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await decideMatchup(ctx.organizationId, ctx.params.eventId!, ctx.params.matchupId, principal.accountId, body.winnerEntryId, body.expectedRevision, body.reason));
    }
  }
];
