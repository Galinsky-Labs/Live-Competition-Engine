import type { Caption } from "@live-competition-engine/db/broadcast";
import { errorResponse, json, readJsonObject, type Authorizer } from "../../../../../../../lib/http";
import { requireProducer, runService } from "../../../../../../../lib/live-http";

export interface CaptionServices {
  listActiveCaptions(o: string, c: string): Promise<Caption[]>;
  setCaption(o: string, c: string, actor: string, input: { kind: unknown; text: unknown; subtitle?: unknown; idempotencyKey: string }): Promise<Caption>;
  clearCaption(o: string, c: string, actor: string, captionId: string): Promise<{ id: string; cleared: boolean }>;
}

/** Producer-only on-air text (lower thirds and captions). Moderation happens in the service. */
export function createCaptionHandlers(authorizer: Authorizer, services: CaptionServices) {
  return {
    async list(request: Request, o: string, c: string) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      return runService(async () => json({ captions: await services.listActiveCaptions(o, c) }));
    },

    async set(request: Request, o: string, c: string) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      const body = await readJsonObject(request, 4096);
      if (body instanceof Response) return body;
      if (typeof body.idempotencyKey !== "string") return errorResponse(400, "invalid_idempotency_key");
      const input = { kind: body.kind, text: body.text, subtitle: body.subtitle, idempotencyKey: body.idempotencyKey };
      return runService(async () => json({ caption: await services.setCaption(o, c, principal.accountId, input) }, 201));
    },

    async clear(request: Request, o: string, c: string, captionId: string) {
      const principal = await requireProducer(authorizer, request, o, c);
      if (principal instanceof Response) return principal;
      return runService(async () => json(await services.clearCaption(o, c, principal.accountId, captionId)));
    }
  };
}
