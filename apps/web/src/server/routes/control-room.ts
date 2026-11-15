import { finishPerformance, liveSnapshot, readTimer, safetyStop, startPerformance, timerCommand, timerKey, updateLiveState } from "@live-competition-engine/db/control-room";
import { getEvent, getPublicEvent } from "@live-competition-engine/db/events";
import { HttpError } from "@/lib/http";
import { canManageEvent, manageEvent } from "../access";
import { json, type RouteDef } from "../router";

export const controlRoomRoutes: RouteDef[] = [
  {
    method: "GET", pattern: ":eventId/live", handler: async ctx => {
      const event = (await canManageEvent(ctx)) ? await getEvent(ctx.organizationId, ctx.params.eventId!) : await getPublicEvent(ctx.organizationId, ctx.params.eventId!);
      if (!event) throw new HttpError(404, "event_not_found");
      const response = json(await liveSnapshot(ctx.organizationId, event));
      response.headers.set("cache-control", "no-store");
      return response;
    }
  },
  {
    method: "POST", pattern: ":eventId/performances/:performanceId/start", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await startPerformance(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.performanceId));
    }
  },
  {
    method: "POST", pattern: ":eventId/performances/:performanceId/complete", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await finishPerformance(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.performanceId, "completed"));
    }
  },
  {
    method: "POST", pattern: ":eventId/performances/:performanceId/skip", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await finishPerformance(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.performanceId, "skipped", (await ctx.body()).reason));
    }
  },
  {
    method: "GET", pattern: ":eventId/performances/:performanceId/timer", handler: async ctx => {
      const event = (await canManageEvent(ctx)) ? await getEvent(ctx.organizationId, ctx.params.eventId!) : await getPublicEvent(ctx.organizationId, ctx.params.eventId!);
      if (!event) throw new HttpError(404, "event_not_found");
      return json(await readTimer(ctx.organizationId, event, timerKey("performance", ctx.params.performanceId!)));
    }
  },
  {
    method: "POST", pattern: ":eventId/performances/:performanceId/timer", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const { expectedSeq, ...command } = await ctx.body();
      return json(await timerCommand(ctx.organizationId, ctx.params.eventId!, timerKey("performance", ctx.params.performanceId!), principal.accountId, command, expectedSeq));
    }
  },
  {
    method: "POST", pattern: ":eventId/safety-stop", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await safetyStop(ctx.organizationId, ctx.params.eventId!, principal.accountId, (await ctx.body()).reason));
    }
  },
  {
    method: "PATCH", pattern: ":eventId/live-state", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await updateLiveState(ctx.organizationId, ctx.params.eventId!, principal.accountId, await ctx.body()));
    }
  }
];
