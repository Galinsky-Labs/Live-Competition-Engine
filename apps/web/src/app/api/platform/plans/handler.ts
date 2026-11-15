import type { SaasPlan } from "@live-competition-engine/db/saas-plans";
import { domainFailure, errorResponse, json, readJsonObject, requireAction, type Authorizer } from "../../../../lib/http";
import { isUuid } from "@live-competition-engine/domain";

export interface PlanAdminDeps {
  list(filter: { status?: SaasPlan["status"] }): Promise<SaasPlan[]>;
  create(actorAccountId: string, input: unknown): Promise<SaasPlan>;
  publish(actorAccountId: string, planId: string): Promise<SaasPlan>;
  retire(actorAccountId: string, planId: string): Promise<SaasPlan>;
}

const statuses = new Set(["draft", "published", "retired"]);

/** LC-49 platform plan catalogue: platform.manage only. */
export function createPlanAdminHandlers(authorizer: Pick<Authorizer, "authorizeAction">, deps: PlanAdminDeps) {
  return {
    async list(request: Request): Promise<Response> {
      const principal = await requireAction(authorizer, request, "platform.manage");
      if (principal instanceof Response) return principal;
      const status = new URL(request.url).searchParams.get("status");
      if (status !== null && !statuses.has(status)) return errorResponse(400, "invalid_status");
      return json({ plans: await deps.list(status ? { status: status as SaasPlan["status"] } : {}) });
    },
    async create(request: Request): Promise<Response> {
      const principal = await requireAction(authorizer, request, "platform.manage");
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 16 * 1024);
      if (body instanceof Response) return body;
      try {
        return json({ plan: await deps.create(principal.accountId, body) }, 201);
      } catch (error) {
        return domainFailure(error);
      }
    },
    async transition(request: Request, planId: string, to: "publish" | "retire"): Promise<Response> {
      const principal = await requireAction(authorizer, request, "platform.manage");
      if (principal instanceof Response) return principal;
      if (!isUuid(planId)) return errorResponse(404, "plan_not_found");
      try {
        const plan = to === "publish" ? await deps.publish(principal.accountId, planId) : await deps.retire(principal.accountId, planId);
        return json({ plan });
      } catch (error) {
        return domainFailure(error);
      }
    }
  };
}
