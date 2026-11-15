import { DomainError, isBoundedText, isUuid } from "./index.ts";
import { MARKDOWN_MAX_LENGTH, safeLinkTarget } from "./markdown.ts";

export function parseSlug(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) throw new DomainError("invalid_slug");
  return value;
}

export interface PageContent { title: string; body: string; mediaIds: string[] }

export function parsePageContent(input: { title?: unknown; body?: unknown; mediaIds?: unknown }): PageContent {
  const title = typeof input.title === "string" ? input.title.trim() : input.title;
  if (!isBoundedText(title, 200, 1)) throw new DomainError("invalid_title");
  const body = input.body ?? "";
  if (typeof body !== "string" || body.length > MARKDOWN_MAX_LENGTH) throw new DomainError("invalid_body");
  const mediaIds = input.mediaIds ?? [];
  if (!Array.isArray(mediaIds) || mediaIds.length > 50 || !mediaIds.every(isUuid)) throw new DomainError("invalid_media_ids");
  return { title: title as string, body, mediaIds: [...new Set(mediaIds as string[])] };
}

/** A scheduled publication must be in the future and within one year. */
export function parsePublishAt(value: unknown, now: Date): Date {
  const date = typeof value === "string" ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) throw new DomainError("invalid_publish_at");
  if (date.getTime() <= now.getTime() || date.getTime() > now.getTime() + 366 * 24 * 3600 * 1000) throw new DomainError("invalid_publish_at");
  return date;
}

export interface NavigationEntryInput { label: string; pageId: string | null; url: string | null; position: number }

/** Navigation: at most 50 entries, each targeting a tenant page or an absolute http(s) URL. */
export function parseNavigation(value: unknown): NavigationEntryInput[] {
  if (!Array.isArray(value) || value.length > 50) throw new DomainError("invalid_navigation");
  return value.map((raw, position) => {
    if (!raw || typeof raw !== "object") throw new DomainError("invalid_navigation");
    const entry = raw as Record<string, unknown>;
    const label = typeof entry.label === "string" ? entry.label.trim() : entry.label;
    if (!isBoundedText(label, 80, 1)) throw new DomainError("invalid_navigation_label");
    const pageId = entry.pageId ?? null;
    const url = entry.url ?? null;
    if ((pageId === null) === (url === null)) throw new DomainError("invalid_navigation_target");
    if (pageId !== null && !isUuid(pageId)) throw new DomainError("invalid_navigation_target");
    if (url !== null && (typeof url !== "string" || !/^https?:\/\//i.test(url) || safeLinkTarget(url) === null)) {
      throw new DomainError("invalid_navigation_target");
    }
    return { label: label as string, pageId: pageId as string | null, url: url as string | null, position };
  });
}
