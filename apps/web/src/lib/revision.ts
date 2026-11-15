/**
 * Optimistic-concurrency and paging helpers shared by profile/event/stage handlers.
 * Revisions travel as strong ETags ("<n>"); clients echo them in If-Match.
 */
export function parseIfMatch(request: Request): number | null | "invalid" {
  const header = request.headers.get("if-match");
  if (header === null) return null;
  const match = /^\s*"?(\d{1,9})"?\s*$/.exec(header);
  if (!match) return "invalid";
  const value = Number(match[1]);
  return value >= 1 ? value : "invalid";
}

export function etag(revision: number): Record<string, string> {
  return { etag: `"${revision}"` };
}

/** Parse ?limit=&after= with bounds; fields are omitted when absent. */
export function pageParams(request: Request): { limit?: number; after?: string } {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "");
  const after = url.searchParams.get("after") ?? undefined;
  return {
    ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 100) } : {}),
    ...(after ? { after } : {})
  };
}
