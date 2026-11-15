import { errorResponse, json } from "../../../../../lib/http";

export interface PaymentJobDeps {
  verify(header: string | null): boolean;
  tasks: Record<string, (now: Date) => Promise<number>>;
}

/**
 * Scheduled maintenance (release expired capacity holds, expire lapsed
 * subscriptions). Authenticated with the JOB_WORKER_SECRET bearer; fails closed.
 */
export function createPaymentJobHandler(deps: PaymentJobDeps) {
  return async function runPaymentJobs(request: Request): Promise<Response> {
    if (!deps.verify(request.headers.get("authorization"))) return errorResponse(401, "unauthorized");
    const now = new Date();
    const results: Record<string, number> = {};
    for (const [name, task] of Object.entries(deps.tasks)) results[name] = await task(now);
    return json({ ranAt: now.toISOString(), results });
  };
}
