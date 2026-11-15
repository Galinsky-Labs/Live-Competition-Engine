import { selectStreamingProvider } from "@live-competition-engine/engine";
import {
  backstageRole, configureStream, getStream, listBackstage, listReadiness, postBackstage, setReadiness, setStreamStatus
} from "@live-competition-engine/db/streams-backstage";
import { getPublicEvent } from "@live-competition-engine/db/events";
import { HttpError } from "@/lib/http";
import { canManageEvent, manageEvent, signedIn } from "../access";
import { json, type RouteContext, type RouteDef } from "../router";

export const streamingProvider = () => selectStreamingProvider(process.env);

async function backstage(ctx: RouteContext) {
  const principal = await signedIn(ctx);
  const who = await backstageRole(ctx.organizationId, ctx.params.eventId!, principal.accountId, await canManageEvent(ctx));
  if (!who) throw new HttpError(403, "forbidden");
  return { principal, who };
}

export const streamBackstageRoutes: RouteDef[] = [
  {
    method: "GET", pattern: ":eventId/stream", handler: async ctx => {
      const manager = await canManageEvent(ctx);
      if (!manager && !(await getPublicEvent(ctx.organizationId, ctx.params.eventId!))) throw new HttpError(404, "event_not_found");
      const stream = await getStream(ctx.organizationId, ctx.params.eventId!);
      const provider = streamingProvider();
      if (!stream) return json({ provider: provider.id, status: "not_configured" });
      return json(manager ? { ...stream, providerAvailable: provider.id } : { provider: stream.provider, status: stream.status, embedUrl: stream.embedUrl, playbackUrl: stream.playbackUrl, recordingUrl: stream.recordingUrl });
    }
  },
  {
    method: "PUT", pattern: ":eventId/stream", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json(await configureStream(ctx.organizationId, ctx.params.eventId!, principal.accountId, streamingProvider(), (await ctx.body()).embedUrl));
    }
  },
  {
    method: "POST", pattern: ":eventId/stream/status", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await setStreamStatus(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.status, body.expectedRevision, body.reason, body.recordingUrl));
    }
  },
  {
    method: "GET", pattern: ":eventId/backstage", handler: async ctx => {
      const { who } = await backstage(ctx);
      const after = Number(ctx.url.searchParams.get("after") ?? "0");
      return json({ role: who.role, messages: await listBackstage(ctx.organizationId, ctx.params.eventId!, who, Number.isSafeInteger(after) ? after : 0), readiness: await listReadiness(ctx.organizationId, ctx.params.eventId!, who) });
    }
  },
  {
    method: "POST", pattern: ":eventId/backstage", handler: async ctx => {
      const { principal, who } = await backstage(ctx);
      return json(await postBackstage(ctx.organizationId, ctx.params.eventId!, principal.accountId, who, await ctx.body()), 201);
    }
  },
  {
    method: "POST", pattern: ":eventId/readiness", handler: async ctx => {
      const { principal, who } = await backstage(ctx);
      const body = await ctx.body();
      return json(await setReadiness(ctx.organizationId, ctx.params.eventId!, principal.accountId, who, body.entryId, body.status, body.note));
    }
  }
];
