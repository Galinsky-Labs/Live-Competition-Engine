import type { EventStatus } from "@live-competition-engine/engine";
import {
  applyTemplate, createEvent, createTemplateVersion, getEvent, getPublicEvent, listEvents, listTemplates,
  setEventConfig, transitionEvent, updateEvent
} from "@live-competition-engine/db/events";
import { listAudit } from "@live-competition-engine/db/audit";
import { getSqlClient } from "@live-competition-engine/db";
import { authorizationHeader, HttpError } from "@/lib/http";
import { getAuth } from "@/lib/server-auth";
import { canManageEvent, manageEvent, manageTenant } from "../access";
import { json, type RouteDef } from "../router";

const transition = (to: EventStatus): RouteDef["handler"] => async ctx => {
  const principal = await manageEvent(ctx);
  const body = await ctx.body();
  return json(await transitionEvent(ctx.organizationId, ctx.params.eventId!, principal.accountId, to, body.expectedRevision, typeof body.reason === "string" ? body.reason : undefined));
};

async function canManageTenantEvents(request: Request, organizationId: string) {
  if (!authorizationHeader(request)) return false;
  try {
    await getAuth().authorizeAction(authorizationHeader(request), "event.manage", { organizationId });
    return true;
  } catch {
    return false;
  }
}

export const eventRoutes: RouteDef[] = [
  {
    method: "GET", pattern: "", handler: async ctx => {
      const includeDrafts = ctx.url.searchParams.get("drafts") === "1" && await canManageTenantEvents(ctx.request, ctx.organizationId);
      return json(await listEvents(ctx.organizationId, { includeDrafts }));
    }
  },
  {
    method: "POST", pattern: "", handler: async ctx => {
      const principal = await getAuth().authorizeAction(authorizationHeader(ctx.request), "event.manage", { organizationId: ctx.organizationId });
      return json(await createEvent(ctx.organizationId, principal.accountId, await ctx.body()), 201);
    }
  },
  {
    method: "GET", pattern: "templates", handler: async ctx => {
      await manageTenant(ctx);
      return json(await listTemplates(ctx.organizationId));
    }
  },
  {
    method: "POST", pattern: "templates", handler: async ctx => {
      const principal = await manageTenant(ctx);
      const body = await ctx.body();
      return json(await createTemplateVersion(ctx.organizationId, principal.accountId, body.key, body.name, body.config), 201);
    }
  },
  {
    method: "GET", pattern: ":eventId", handler: async ctx => {
      const event = await canManageEvent(ctx) ? await getEvent(ctx.organizationId, ctx.params.eventId!) : await getPublicEvent(ctx.organizationId, ctx.params.eventId!);
      if (!event) throw new HttpError(404, "event_not_found");
      return json(event);
    }
  },
  {
    method: "PATCH", pattern: ":eventId", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const { expectedRevision, ...patch } = await ctx.body();
      return json(await updateEvent(ctx.organizationId, ctx.params.eventId!, principal.accountId, expectedRevision, patch));
    }
  },
  {
    method: "PUT", pattern: ":eventId/config", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await setEventConfig(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.expectedRevision, body.config));
    }
  },
  {
    method: "POST", pattern: ":eventId/apply-template", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await applyTemplate(ctx.organizationId, ctx.params.eventId!, principal.accountId, body.expectedRevision, body.templateId));
    }
  },
  { method: "POST", pattern: ":eventId/publish", handler: transition("published") },
  { method: "POST", pattern: ":eventId/unpublish", handler: transition("draft") },
  { method: "POST", pattern: ":eventId/go-live", handler: transition("live") },
  { method: "POST", pattern: ":eventId/pause", handler: transition("paused") },
  { method: "POST", pattern: ":eventId/resume", handler: transition("live") },
  { method: "POST", pattern: ":eventId/complete", handler: transition("completed") },
  { method: "POST", pattern: ":eventId/cancel", handler: transition("cancelled") },
  {
    method: "GET", pattern: ":eventId/audit", handler: async ctx => {
      await manageEvent(ctx);
      return json(await listAudit(getSqlClient(), ctx.organizationId, ctx.url.searchParams.get("subjectType") ?? undefined, ctx.url.searchParams.get("subjectId") ?? undefined));
    }
  }
];
