import { parseCursor } from "@live-competition-engine/domain/backstage";
import type { BackstageAuthor, BackstageMessage } from "@live-competition-engine/db/backstage";
import type { RunOfShowRound } from "@live-competition-engine/db/run-of-show";
import { errorResponse, json, readJsonObject, type Authorizer } from "../../../../../../../lib/http";
import { requireProducer, resolveLiveRole, runService } from "../../../../../../../lib/live-http";

type Org = string;
type Comp = string;

export interface BackstageServices {
  listBackstageMessages(o: Org, c: Comp, viewer: BackstageAuthor, since: number): Promise<{ messages: BackstageMessage[]; cursor: number; hasMore: boolean }>;
  postCheckin(o: Org, c: Comp, author: BackstageAuthor, input: { performanceId: string; readiness: unknown; note?: unknown; idempotencyKey: string }): Promise<BackstageMessage>;
  postCue(o: Org, c: Comp, author: BackstageAuthor, input: { performanceId: string; body: unknown; idempotencyKey: string }): Promise<BackstageMessage>;
  acknowledgeCue(o: Org, c: Comp, author: BackstageAuthor, input: { cueId: string; idempotencyKey: string }): Promise<BackstageMessage>;
  postJudgeMessage(o: Org, c: Comp, author: BackstageAuthor, input: { body: unknown; idempotencyKey: string }): Promise<BackstageMessage>;
  getReadiness(o: Org, c: Comp): Promise<unknown[]>;
  setEntryAccountLink(o: Org, c: Comp, actor: string, input: { entryId: string; accountId: string; linked: boolean }): Promise<unknown>;
  getRunOfShow(o: Org, c: Comp): Promise<RunOfShowRound[]>;
}

const now = () => new Date().toISOString();

/**
 * Backstage API. Every route resolves the caller's live role (producer > judge >
 * performer) from role grants scoped to the competition; identity never comes from the body.
 */
export function createBackstageHandlers(authorizer: Authorizer, services: BackstageServices) {
  async function withRole(request: Request, o: Org, c: Comp, fn: (author: BackstageAuthor) => Promise<Response>) {
    const resolved = await resolveLiveRole(authorizer, request, o, c);
    if (resolved instanceof Response) return resolved;
    return runService(() => fn({ accountId: resolved.principal.accountId, role: resolved.role }));
  }

  async function withBody(request: Request, o: Org, c: Comp, fn: (author: BackstageAuthor, body: Record<string, unknown>) => Promise<Response>) {
    return withRole(request, o, c, async author => {
      const body = await readJsonObject(request, 8 * 1024);
      if (body instanceof Response) return body;
      if (typeof body.idempotencyKey !== "string") return errorResponse(400, "invalid_idempotency_key");
      return fn(author, body);
    });
  }

  return {
    /** GET ?since=<seq>: role-filtered feed; poll with the returned cursor. */
    messages(request: Request, o: Org, c: Comp) {
      return withRole(request, o, c, async author => {
        const since = parseCursor(new URL(request.url).searchParams.get("since"));
        const page = await services.listBackstageMessages(o, c, author, since);
        return json({ role: author.role, ...page, serverNow: now() });
      });
    },

    checkin(request: Request, o: Org, c: Comp) {
      return withBody(request, o, c, async (author, body) => {
        if (typeof body.performanceId !== "string") return errorResponse(400, "invalid_performance_id");
        return json({ message: await services.postCheckin(o, c, author, {
          performanceId: body.performanceId, readiness: body.readiness, note: body.note, idempotencyKey: body.idempotencyKey as string
        }) }, 201);
      });
    },

    cue(request: Request, o: Org, c: Comp) {
      return withBody(request, o, c, async (author, body) => {
        if (typeof body.performanceId !== "string") return errorResponse(400, "invalid_performance_id");
        return json({ message: await services.postCue(o, c, author, {
          performanceId: body.performanceId, body: body.body, idempotencyKey: body.idempotencyKey as string
        }) }, 201);
      });
    },

    ack(request: Request, o: Org, c: Comp, cueId: string) {
      return withBody(request, o, c, async (author, body) =>
        json({ message: await services.acknowledgeCue(o, c, author, { cueId, idempotencyKey: body.idempotencyKey as string }) }, 201));
    },

    judgeMessage(request: Request, o: Org, c: Comp) {
      return withBody(request, o, c, async (author, body) =>
        json({ message: await services.postJudgeMessage(o, c, author, { body: body.body, idempotencyKey: body.idempotencyKey as string }) }, 201));
    },

    async readiness(request: Request, o: Org, c: Comp) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      return runService(async () => json({ readiness: await services.getReadiness(o, c), serverNow: now() }));
    },

    async link(request: Request, o: Org, c: Comp) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      if (typeof body.entryId !== "string" || typeof body.accountId !== "string" || typeof body.linked !== "boolean") {
        return errorResponse(400, "invalid_input");
      }
      const input = { entryId: body.entryId, accountId: body.accountId, linked: body.linked };
      return runService(async () => json({ link: await services.setEntryAccountLink(o, c, principal.accountId, input) }));
    },

    runOfShow(request: Request, o: Org, c: Comp) {
      return withRole(request, o, c, async () => json({ rounds: await services.getRunOfShow(o, c), serverNow: now() }));
    }
  };
}
