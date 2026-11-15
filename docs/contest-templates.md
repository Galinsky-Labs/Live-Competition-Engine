# LC-14 Competition configuration (contest templates)

Tenant-owned, versioned templates describing a contest format without product vocabulary.

## Configuration schema (`packages/domain/src/contest-templates.ts`, zod, strict objects)

| Section | Fields |
| --- | --- |
| `format` | `participation` individual/group/mixed, `matchup` none/head_to_head/multi_side, `groupSize {min,max}` (required for group/mixed only) |
| `eligibility` | `requiresApplication`, optional `age {min,max}`, `maxEntriesPerParticipant` 1–100, optional ISO-3166 alpha-2 `regions`, `customRules [{key, description}]` ≤ 50 |
| `scoring` | `configRef` (reference to a rubric owned by the scoring milestone), `scaleMin < scaleMax`, `precision` 0–4, `aggregation` mean/median/sum/trimmed_mean |
| `judging` | `mode` panel/audience/hybrid; `panelSize` required for panel and hybrid, forbidden for audience; `audienceWeight` ∈ (0,1) required for hybrid only; `blind` |
| `duration` | `performanceSeconds {min,max}`, `overtimePolicy` none/warn/penalize/disqualify |
| `phases` | 1–20 `{key, label, kind (audition/qualifier/heat/semifinal/final/custom), customKind (custom only), timed, durationSeconds (timed only), advancement?}`; unique keys. `advancement` is validated by the LC-15 contract parser. |

Unknown keys anywhere are rejected. Validation errors return HTTP 400
`invalid_template_config` with up to 20 `{path, message}` issues. Bodies are capped at 64 KiB
(and `pg_column_size(config) <= 64 KiB` in the database).

## Versioning (`0015_contest_templates.sql`)

* `contest_templates` (name unique per tenant, case-insensitive) owns `contest_template_versions`.
* At most one **draft** per template (partial unique index). Draft edits require the draft
  `revision` (`If-Match`). Saving without `If-Match` when no draft exists opens version *n+1*.
* **Publishing** freezes the draft. A trigger rejects any UPDATE/DELETE of a published version,
  so revisions can never mutate a published version. `config_hash` (sha256 of canonical JSON)
  is recorded and re-verified at publication.
* Applying to an event (`PUT /competitions/{id}/template`, `If-Match: <event revision>`) requires
  a published version of the same tenant and an event in `draft` or `published`. It stores
  `template_version_id` + resolved `template_snapshot` + `template_applied_at` on the event and
  bumps the event revision. Later template versions never change the event.
* Audit: `contest_template.created`, `.draft_saved`, `.version_published`, `event.template_applied`.
  Template writes lock the template row (`FOR UPDATE`), so concurrent saves/open-draft calls
  serialize; stale revisions get `contest_template_revision_conflict` (409).

## HTTP (all `event.manage`; tenant scope for templates, competition scope for apply)

* `GET|POST /api/organizations/{org}/contest-templates` (`POST {name, config}`)
* `GET /api/organizations/{org}/contest-templates/{templateId}` (all versions)
* `PUT /api/organizations/{org}/contest-templates/{templateId}/draft` `{config}`
* `POST /api/organizations/{org}/contest-templates/{templateId}/publish` (+ `If-Match`)
* `GET|PUT /api/organizations/{org}/competitions/{competitionId}/template` (`PUT {templateVersionId}` + `If-Match`)

## Tested

Domain: mode-specific rules, ranges, unknown keys, phases. Integration: draft/publish/new draft,
DB-level immutability, audit trail, duplicate names, concurrent saves (one winner), apply/snapshot
isolation from later drafts, live events refused, cross-tenant denial for every operation.

## Not implemented

Engines that *enforce* these rules at runtime (eligibility checks at registration, scoring
aggregation, overtime penalties) belong to later milestones; the template is configuration only.
Templates cannot be renamed or deleted.
