import {
  applicationHistory, decideApplication, getOwnApplication, listApplications, listLineup, promoteFromWaitlist,
  reviseApplication, setLineup, submitApplication, withdrawApplication
} from "@live-competition-engine/db/registration";
import { getPublicEvent } from "@live-competition-engine/db/events";
import { HttpError } from "@/lib/http";
import { canManageEvent, manageEvent, signedIn } from "../access";
import { json, type RouteDef } from "../router";

export const registrationRoutes: RouteDef[] = [
  {
    method: "POST", pattern: ":eventId/applications", handler: async ctx => {
      const principal = await signedIn(ctx);
      return json(await submitApplication(ctx.organizationId, ctx.params.eventId!, principal.accountId, await ctx.body()), 201);
    }
  },
  {
    method: "GET", pattern: ":eventId/applications/mine", handler: async ctx => {
      const principal = await signedIn(ctx);
      const own = await getOwnApplication(ctx.organizationId, ctx.params.eventId!, principal.accountId);
      if (!own) throw new HttpError(404, "application_not_found");
      return json(own);
    }
  },
  {
    method: "PUT", pattern: ":eventId/applications/:applicationId", handler: async ctx => {
      const principal = await signedIn(ctx);
      const { expectedRevision, ...input } = await ctx.body();
      return json(await reviseApplication(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.applicationId, expectedRevision, input));
    }
  },
  {
    method: "POST", pattern: ":eventId/applications/:applicationId/withdraw", handler: async ctx => {
      const principal = await signedIn(ctx);
      return json(await withdrawApplication(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.applicationId));
    }
  },
  {
    method: "GET", pattern: ":eventId/applications", handler: async ctx => {
      await manageEvent(ctx);
      return json(await listApplications(ctx.organizationId, ctx.params.eventId!, ctx.url.searchParams.get("status") ?? undefined));
    }
  },
  {
    method: "POST", pattern: ":eventId/applications/promote", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const promoted = await promoteFromWaitlist(ctx.organizationId, ctx.params.eventId!, principal.accountId);
      if (!promoted) throw new HttpError(409, "waitlist_empty");
      return json(promoted);
    }
  },
  {
    method: "POST", pattern: ":eventId/applications/:applicationId/decide", handler: async ctx => {
      const principal = await manageEvent(ctx);
      const body = await ctx.body();
      return json(await decideApplication(ctx.organizationId, ctx.params.eventId!, principal.accountId, ctx.params.applicationId, body.status, body.expectedRevision, body.reason));
    }
  },
  {
    method: "GET", pattern: ":eventId/applications/:applicationId/history", handler: async ctx => {
      await manageEvent(ctx);
      return json(await applicationHistory(ctx.organizationId, ctx.params.applicationId!));
    }
  },
  {
    method: "GET", pattern: ":eventId/stages/:stageId/lineup", handler: async ctx => {
      if (!(await canManageEvent(ctx)) && !(await getPublicEvent(ctx.organizationId, ctx.params.eventId!))) throw new HttpError(404, "event_not_found");
      return json(await listLineup(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId!));
    }
  },
  {
    method: "PUT", pattern: ":eventId/stages/:stageId/lineup", handler: async ctx => {
      const principal = await manageEvent(ctx);
      return json({ count: await setLineup(ctx.organizationId, ctx.params.eventId!, ctx.params.stageId, principal.accountId, (await ctx.body()).entryIds) });
    }
  }
];
