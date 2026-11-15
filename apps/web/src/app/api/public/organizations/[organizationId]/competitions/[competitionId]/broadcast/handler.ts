import { publicTimerRemaining } from "@live-competition-engine/domain/broadcast";
import type { PublicOverlay, PublicScoreboard } from "@live-competition-engine/db/broadcast";
import { publicJson, publicNotFound } from "../../../../../../../../lib/live-http";

export interface PublicBroadcastServices {
  getPublicOverlay(o: string, c: string): Promise<PublicOverlay | null>;
  getPublicScoreboard(o: string, c: string): Promise<PublicScoreboard | null>;
  clock?: () => number;
}

/**
 * Anonymous broadcast data for OBS browser sources and public pages.
 *
 * Latency handling: the body carries a monotonic `sequence` (overlays drop older
 * payloads) and `serverNow`; the `x-server-now` header is present on 200 AND 304 so a
 * client can keep its clock offset fresh while the content is unchanged. The ETag
 * covers only stable content (timer described by `runningSince`, not by a ticking
 * remaining value), so polling every second is mostly 304s.
 */
export function createPublicBroadcastHandlers(services: PublicBroadcastServices) {
  const clock = services.clock ?? (() => Date.now());
  return {
    async overlay(request: Request, o: string, c: string): Promise<Response> {
      const overlay = await services.getPublicOverlay(o, c);
      if (!overlay) return publicNotFound();
      const serverNow = clock();
      return publicJson(request, { ...overlay }, {
        serverNow,
        timerRemainingMs: overlay.timer ? publicTimerRemaining(overlay.timer, serverNow) : null
      }, { maxAgeSeconds: 1, headers: { "x-server-now": String(serverNow) } });
    },

    async scoreboard(request: Request, o: string, c: string): Promise<Response> {
      const board = await services.getPublicScoreboard(o, c);
      if (!board) return publicNotFound();
      const serverNow = clock();
      return publicJson(request, { ...board }, { serverNow }, { maxAgeSeconds: 5, headers: { "x-server-now": String(serverNow) } });
    }
  };
}
