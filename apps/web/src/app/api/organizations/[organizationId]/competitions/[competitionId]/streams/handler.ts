import type { StreamingProvider } from "@live-competition-engine/db/providers/streaming";
import type { StreamView, StreamWithKey } from "@live-competition-engine/db/streams";
import { errorResponse, isUuid, json, readJsonObject, type Authorizer } from "../../../../../../../lib/http";
import { intField, requireProducer, runService } from "../../../../../../../lib/live-http";

export interface StreamServices {
  provider: () => Promise<StreamingProvider>;
  createStream(organizationId: string, competitionId: string, actor: string, input: { idempotencyKey: string }, provider: StreamingProvider): Promise<StreamWithKey>;
  listStreams(organizationId: string, competitionId: string): Promise<StreamView[]>;
  getStream(organizationId: string, streamId: string): Promise<StreamView>;
  recreateStream(organizationId: string, streamId: string, actor: string, input: { idempotencyKey: string }, provider: StreamingProvider): Promise<StreamWithKey>;
  resetStreamKey(organizationId: string, streamId: string, actor: string, provider: StreamingProvider): Promise<StreamWithKey>;
  endStream(organizationId: string, streamId: string, actor: string, provider: StreamingProvider): Promise<StreamView>;
  setStreamPublished(organizationId: string, streamId: string, actor: string, input: { published: boolean; expectedRevision: number }): Promise<StreamView>;
}

/** The stream key appears only in the response that created it. */
const withKey = (result: StreamWithKey, status: number) => json({
  stream: result.stream,
  replayed: result.replayed,
  ...(result.streamKey ? { streamKey: result.streamKey, streamKeyNotice: "Shown once. Store it in your encoder; it cannot be retrieved again." } : {})
}, result.replayed ? 200 : status);

export function createStreamHandlers(authorizer: Authorizer, services: StreamServices) {
  async function streamInCompetition(organizationId: string, competitionId: string, streamId: string) {
    if (!isUuid(streamId)) return null;
    const stream = await services.getStream(organizationId, streamId);
    return stream.competitionId === competitionId ? stream : null;
  }

  return {
    async list(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireProducer(authorizer, request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      return runService(async () => json({ streams: await services.listStreams(organizationId, competitionId) }));
    },

    async create(request: Request, organizationId: string, competitionId: string) {
      const principal = await requireProducer(authorizer, request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      if (typeof body.idempotencyKey !== "string") return errorResponse(400, "invalid_idempotency_key");
      const idempotencyKey = body.idempotencyKey;
      return runService(async () => withKey(
        await services.createStream(organizationId, competitionId, principal.accountId, { idempotencyKey }, await services.provider()),
        201
      ));
    },

    async get(request: Request, organizationId: string, competitionId: string, streamId: string) {
      const principal = await requireProducer(authorizer, request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      return runService(async () => {
        const stream = await streamInCompetition(organizationId, competitionId, streamId);
        return stream ? json({ stream }) : errorResponse(404, "stream_not_found");
      });
    },

    /** POST {action: "recreate"|"reset_key"|"end"|"publish"|"unpublish", ...}. */
    async act(request: Request, organizationId: string, competitionId: string, streamId: string) {
      const principal = await requireProducer(authorizer, request, organizationId, competitionId);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      const actor = principal.accountId;
      return runService(async () => {
        const stream = await streamInCompetition(organizationId, competitionId, streamId);
        if (!stream) return errorResponse(404, "stream_not_found");
        switch (body.action) {
          case "recreate": {
            if (typeof body.idempotencyKey !== "string") return errorResponse(400, "invalid_idempotency_key");
            return withKey(await services.recreateStream(organizationId, streamId, actor, { idempotencyKey: body.idempotencyKey }, await services.provider()), 201);
          }
          case "reset_key":
            return withKey(await services.resetStreamKey(organizationId, streamId, actor, await services.provider()), 200);
          case "end":
            return json({ stream: await services.endStream(organizationId, streamId, actor, await services.provider()) });
          case "publish":
          case "unpublish": {
            const expectedRevision = intField(body, "expectedRevision");
            if (expectedRevision === undefined) return errorResponse(400, "invalid_expected_revision");
            return json({ stream: await services.setStreamPublished(organizationId, streamId, actor, { published: body.action === "publish", expectedRevision }) });
          }
          default:
            return errorResponse(400, "invalid_action");
        }
      });
    }
  };
}
