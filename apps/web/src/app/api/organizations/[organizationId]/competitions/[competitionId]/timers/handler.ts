import type { TimerCommandType } from "@live-competition-engine/domain/timer";
import type { TimerCommandInput, TimerView } from "@live-competition-engine/db/timers";
import { errorResponse, isUuid, json, readJsonObject, type Authorizer } from "../../../../../../../lib/http";
import { intField, requireProducer, resolveLiveRole, runService } from "../../../../../../../lib/live-http";

export interface TimerServices {
  createTimer(o: string, c: string, actor: string, input: { performanceId?: string | null; label: unknown; durationMs: unknown; maxExtensionMs?: unknown }): Promise<TimerView>;
  listTimers(o: string, c: string): Promise<TimerView[]>;
  getTimer(o: string, timerId: string): Promise<TimerView>;
  issueTimerCommand(o: string, timerId: string, actor: string, input: TimerCommandInput): Promise<{ view: TimerView; replayed: boolean }>;
  getTimerLog(o: string, timerId: string): Promise<unknown[]>;
}

/**
 * Timers: reads for any live role (producer, judge, performer) so every screen
 * renders the same server time; commands and the log are producer-only.
 * Clients render `remainingMs - (clientNow - receivedAt)` while `status === "running"`.
 */
export function createTimerHandlers(authorizer: Authorizer, services: TimerServices) {
  async function timerInCompetition(o: string, c: string, timerId: string) {
    if (!isUuid(timerId)) return null;
    const timer = await services.getTimer(o, timerId);
    return timer.competitionId === c ? timer : null;
  }

  return {
    async list(request: Request, o: string, c: string) {
      const role = await resolveLiveRole(authorizer, request, o, c);
      if (role instanceof Response) return role;
      return runService(async () => json({ timers: await services.listTimers(o, c) }));
    },

    async create(request: Request, o: string, c: string) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      if (body.performanceId !== undefined && body.performanceId !== null && typeof body.performanceId !== "string") {
        return errorResponse(400, "invalid_performance_id");
      }
      return runService(async () => json({ timer: await services.createTimer(o, c, principal.accountId, {
        performanceId: (body.performanceId as string | null | undefined) ?? null,
        label: body.label, durationMs: body.durationMs, maxExtensionMs: body.maxExtensionMs
      }) }, 201));
    },

    async get(request: Request, o: string, c: string, timerId: string) {
      const role = await resolveLiveRole(authorizer, request, o, c);
      if (role instanceof Response) return role;
      return runService(async () => {
        const timer = await timerInCompetition(o, c, timerId);
        return timer ? json({ timer }) : errorResponse(404, "timer_not_found");
      });
    },

    /** POST {type, amountMs?, durationMs?, reason?, idempotencyKey, expectedSequence?} */
    async command(request: Request, o: string, c: string, timerId: string) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      if (typeof body.type !== "string") return errorResponse(400, "invalid_timer_command");
      if (typeof body.idempotencyKey !== "string") return errorResponse(400, "invalid_idempotency_key");
      if (body.reason !== undefined && typeof body.reason !== "string") return errorResponse(400, "invalid_timer_reason");
      const expectedSequence = intField(body, "expectedSequence");
      const input: TimerCommandInput = {
        type: body.type as TimerCommandType,
        amountMs: (body.amountMs as number | undefined) ?? null,
        durationMs: (body.durationMs as number | undefined) ?? null,
        reason: (body.reason as string | undefined) ?? null,
        idempotencyKey: body.idempotencyKey,
        ...(expectedSequence !== undefined ? { expectedSequence } : {})
      };
      return runService(async () => {
        if (!(await timerInCompetition(o, c, timerId))) return errorResponse(404, "timer_not_found");
        const result = await services.issueTimerCommand(o, timerId, principal.accountId, input);
        return json({ timer: result.view, replayed: result.replayed }, result.replayed ? 200 : 201);
      });
    },

    async log(request: Request, o: string, c: string, timerId: string) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      return runService(async () => {
        if (!(await timerInCompetition(o, c, timerId))) return errorResponse(404, "timer_not_found");
        return json({ commands: await services.getTimerLog(o, timerId) });
      });
    }
  };
}
