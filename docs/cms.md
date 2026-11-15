# LC-45 Content management system

Tenant pages with drafts, immutable published versions, rollback, scheduled publishing,
media references and navigation. Gated by the `cms` feature (LC-08/LC-44).

## Storage (migration `0063_cms.sql`)

| Table | Notes |
| --- | --- |
| `cms_pages` | Slug unique per tenant (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤80), draft title/body/media ids, optimistic `draft_revision`, pointer to the live `published_version`. |
| `cms_page_versions` | Immutable (trigger blocks UPDATE/DELETE). Stores source Markdown **and** the rendered HTML produced at publish time, media ids, `source` (`publish`, `rollback` with `source_version`, `schedule`). |
| `cms_scheduled_publications` | Snapshot of the draft frozen when scheduled; one pending per page; `pending → published | cancelled`. |
| `cms_navigation_entries` | Ordered labels targeting a tenant page (composite FK) or an absolute http(s) URL. |

## Rendering

`packages/domain/src/markdown.ts` is a pure renderer for a restricted subset: headings (`#`–`###` → h2–h4),
paragraphs, bullet/numbered lists, quotes, fenced code, inline code, strong, emphasis and links.
All source text is HTML-escaped; raw HTML is never passed through. Link targets are allowed only for
`http(s)://` (with a host), `mailto:` and relative URLs; `javascript:`, `data:`, protocol-relative and other
schemes render as plain text. External links get `rel="nofollow noopener noreferrer"`.

## Service (`packages/db/src/cms.ts`)

`createPage`, `updateDraft` (expectedRevision), `publishPage` (expectedDraftRevision), `rollbackPage`
(publishes an older version's content as a new version), `schedulePublish`, `cancelScheduledPublish`,
`runDueScheduledPublications` (worker; `FOR UPDATE SKIP LOCKED`; registered as the `cms.publish_due` job in LC-47),
`setNavigation` (atomic replace), `listNavigation`, `listPages`, `getPageForEditing`, `getPublishedPage`.

* Writes call `requireEnabledFeature("cms")` before side effects. Public reads return nothing when `cms` is off.
* Media references must be unrevoked LC-11 `media_library` items of the same tenant.
* Version numbers are allocated under the page row lock; concurrent publishes get distinct versions.
* `getPublishedPage` returns null when the page was hidden/taken down by moderation (`isSubjectHidden(org, "page", pageId)`).
* All writes audit `cms.*` in the same transaction.

## HTTP

| Method | Path | Who |
| --- | --- | --- |
| GET, POST | `/api/organizations/{org}/cms/pages` | `tenant.manage` |
| GET, PUT | `/api/organizations/{org}/cms/pages/{pageId}` | `tenant.manage` |
| POST | `.../pages/{pageId}/publish` `{expectedDraftRevision}` | `tenant.manage` |
| POST | `.../pages/{pageId}/rollback` `{version}` | `tenant.manage` |
| POST, DELETE | `.../pages/{pageId}/schedule` `{publishAt, expectedDraftRevision}` | `tenant.manage` |
| GET, PUT | `/api/organizations/{org}/cms/navigation` `{entries: [{label, pageId | url}]}` | `tenant.manage` |
| GET | `/api/public/organizations/{org}/pages/{slug}` | anonymous (published projection only) |
| GET | `/api/public/organizations/{org}/navigation` | anonymous |

Public page: `/pages/{org}/{slug}` — server-rendered article with tenant navigation; 404 when unpublished,
hidden, unknown or the feature is off.

## Not claimed

* Media references are exposed as ids; embedding media players in public pages is not implemented.
* No WYSIWYG editor/admin page for CMS; editing is via the API.
* Scheduled publication requires something to call the LC-47 job runner (cron hitting `/api/jobs/run`).
