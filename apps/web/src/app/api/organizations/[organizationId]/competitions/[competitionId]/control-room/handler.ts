import { DomainError } from "@live-competition-engine/domain";
import type { ControlRoomView, ShowCommand } from "@live-competition-engine/db/control-room";
import { json, readJsonObject, type Authorizer } from "../../../../../../../lib/http";
import { intField, requireProducer, runService } from "../../../../../../../lib/live-http";

export interface ControlRoomServices {
  getControlRoom(o: string, c: string): Promise<ControlRoomView>;
  changeShowState(o: string, c: string, actor: string, command: ShowCommand, expectedRevision?: number): Promise<unknown>;
  safetyStop(o: string, c: string, actor: string, reason: unknown): Promise<unknown>;
  createRound(o: string, c: string, actor: string, input: { label: unknown }): Promise<unknown>;
  addPerformance(o: string, c: string, actor: string, input: { roundId: unknown; entryId: unknown }): Promise<unknown>;
  reorderRound(o: string, c: string, actor: string, roundId: string, performanceIds: unknown, expectedRevision?: number): Promise<unknown>;
  transitionRound(o: string, c: string, actor: string, roundId: string, to: unknown, expectedRevision?: number): Promise<unknown>;
  transitionPerformance(o: string, c: string, actor: string, performanceId: string, to: unknown, expectedRevision?: number): Promise<unknown>;
  setRoundPublication(o: string, c: string, actor: string, roundId: string, input: { published: unknown; expectedRevision?: number }): Promise<unknown>;
}

type Action = (actor: string, body: Record<string, unknown>) => Promise<unknown>;

/** Producer control room. Every route requires `event.manage` for the competition and is audited by the service. */
export function createControlRoomHandlers(authorizer: Authorizer, services: ControlRoomServices) {
  async function act(request: Request, o: string, c: string, action: Action, status = 200): Promise<Response> {
    const principal = await requireProducer(authorizer, request, o, c);
    if (principal instanceof Response) return principal;
    const body = await readJsonObject(request, 64 * 1024);
    if (body instanceof Response) return body;
    return runService(async () => json({ result: await action(principal.accountId, body) }, status));
  }

  const revision = (body: Record<string, unknown>) => intField(body, "expectedRevision");

  return {
    async view(request: Request, o: string, c: string) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      return runService(async () => json(await services.getControlRoom(o, c)));
    },

    show(request: Request, o: string, c: string) {
      return act(request, o, c, async (actor, body) => {
        if (body.command !== "start" && body.command !== "resume" && body.command !== "end") throw new DomainError("invalid_show_command");
        return services.changeShowState(o, c, actor, body.command, revision(body));
      });
    },

    safetyStop(request: Request, o: string, c: string) {
      return act(request, o, c, (actor, body) => services.safetyStop(o, c, actor, body.reason));
    },

    createRound(request: Request, o: string, c: string) {
      return act(request, o, c, (actor, body) => services.createRound(o, c, actor, { label: body.label }), 201);
    },

    addPerformance(request: Request, o: string, c: string, roundId: string) {
      return act(request, o, c, (actor, body) => services.addPerformance(o, c, actor, { roundId, entryId: body.entryId }), 201);
    },

    reorder(request: Request, o: string, c: string, roundId: string) {
      return act(request, o, c, (actor, body) => services.reorderRound(o, c, actor, roundId, body.performanceIds, revision(body)));
    },

    roundStatus(request: Request, o: string, c: string, roundId: string) {
      return act(request, o, c, (actor, body) => services.transitionRound(o, c, actor, roundId, body.status, revision(body)));
    },

    performanceStatus(request: Request, o: string, c: string, performanceId: string) {
      return act(request, o, c, (actor, body) => services.transitionPerformance(o, c, actor, performanceId, body.status, revision(body)));
    },

    publication(request: Request, o: string, c: string, roundId: string) {
      return act(request, o, c, (actor, body) => {
        const expectedRevision = revision(body);
        return services.setRoundPublication(o, c, actor, roundId, { published: body.published, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
      });
    }
  };
}
