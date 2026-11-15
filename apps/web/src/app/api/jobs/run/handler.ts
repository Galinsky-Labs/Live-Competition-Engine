import { secretsEqual } from "@live-competition-engine/db/providers/email";
import { errorResponse, json } from "../../../../lib/http";

export type RunWorker = (options: { limit: number }) => Promise<Record<string, unknown>>;

/**
 * Cron-friendly worker endpoint: `POST /api/jobs/run` with `Authorization: Bearer <JOB_WORKER_SECRET>`.
 * Fails closed (503) when the secret is not configured; constant-time comparison otherwise.
 */
export function createJobRunHandler(secret: () => string | undefined, run: RunWorker) {
  return async function post(request: Request): Promise<Response> {
    const expected = secret();
    if (!expected) return errorResponse(503, "job_worker_not_configured");
    const match = /^Bearer (\S{1,512})$/.exec(request.headers.get("authorization") ?? "");
    if (!match || !secretsEqual(match[1]!, expected)) return errorResponse(401, "invalid");
    const limitParam = new URL(request.url).searchParams.get("limit");
    const limit = limitParam === null ? 25 : Number(limitParam);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return errorResponse(400, "invalid_limit");
    return json(await run({ limit }));
  };
}
