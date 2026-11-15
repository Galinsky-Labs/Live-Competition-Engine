# Events and contest configuration (LC-13, LC-14)

An *event* is a row in `competitions`. Lifecycle (`@live-competition-engine/engine/events`):

`draft → published → live ⇄ paused → completed`, plus `cancelled` from any non-final state (reason required, shown publicly) and `published → draft` (unpublish). Every mutation takes `expectedRevision`; concurrent editors on the same revision get `409 revision_conflict` (row lock + revision compare). Publishing is blocked (`409 event_not_publishable` with `blockers`) until the event has a start time, a venue or remote stream, and a valid configuration. Drafts are never returned by public reads; all reads and writes are scoped by `organization_id`.

Contest configuration (`contest-config.ts`) is a strict, versioned (`schemaVersion: 1`), domain-neutral schema: format (`solo`, `head_to_head`, `group`), product labels, eligibility, registration window, judging panel, scoring criteria/aggregation/normalization/tie-breaks, timing, audience and critique options. Tenants publish immutable template versions (`competition_templates`, trigger-enforced) and apply one to a draft event, which snapshots the config (template id + version recorded). Configuration is locked once an event leaves draft.

All changes append to `engine_audit_log`.

## API (`/api/organizations/{orgId}/events`)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/` (`?drafts=1` for managers) | public |
| POST | `/` | event.manage (tenant scope) |
| GET/POST | `/templates` | tenant.manage |
| GET | `/{eventId}` | public when not draft; managers see drafts |
| PATCH | `/{eventId}` | event.manage |
| PUT | `/{eventId}/config` | event.manage (draft only) |
| POST | `/{eventId}/apply-template` | event.manage (draft only) |
| POST | `/{eventId}/publish`, `unpublish`, `go-live`, `pause`, `resume`, `complete`, `cancel` | event.manage |
| GET | `/{eventId}/audit` | event.manage |

UI: `/o/{slug}` (event list, create), `/o/{slug}/events/{id}` (accessible public detail page with time-zone aware times, venue and accessibility notes), `/o/{slug}/events/{id}/manage` (producer console).
