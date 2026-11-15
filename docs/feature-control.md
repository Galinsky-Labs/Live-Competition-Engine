# LC-44 Global feature-control console

Platform operators control which feature families are available; tenant operators keep their
own overrides inside that envelope.

## Model

* **Platform flags** — LC-08 `feature_flags` rows at `platform` scope. A feature is off unless the platform enables it.
* **Tenant ceilings** — `tenant_feature_ceilings` (migration `0061`), owned by the platform. `locked = true`
  means tenant operators may not enable the feature for that tenant at tenant, event or account scope.
* **Tenant overrides** — LC-08 rows at `tenant`/`event`/`account` scope; any explicit `false` vetoes.

Locking a feature also writes the LC-08 tenant flag to `false` (through `setFeatureFlag`), so every existing
`requireEnabledFeature` caller observes the lock as a tenant veto without knowing about ceilings.
Unlocking leaves the tenant flag off; the tenant decides whether to re-enable.

## Service (`packages/db/src/feature-control.ts`)

A wrapper around LC-08 `setFeatureFlag` (`feature-flags.ts` is unchanged):

| Function | Authorization (caller) | Audit |
| --- | --- | --- |
| `setPlatformFeature` | `platform.manage` | `feature.platform_flag_set` (platform chain) |
| `setTenantScopedFeature` | `tenant.manage` | `feature.tenant_flag_set` (tenant chain); refuses enable under a lock (`feature_locked_by_platform`) |
| `setTenantCeiling` | `platform.manage` | `feature.ceiling_set` in both platform and tenant chains |
| `effectiveTenantFeatures` | `tenant.manage` | read only (no decision audit) |
| `listPlatformFeatures`, `listTenantOverrides` | `platform.manage` | read only |

Concurrency: optimistic revisions on flags (LC-08) and ceilings. A per-(tenant, feature) transaction
advisory lock is held shared by tenant writes and exclusive by ceiling writes while the ceiling is read
and the LC-08 write runs, so a tenant enable cannot slip in between a platform lock check and the veto.
The integration suite races both and asserts the feature always ends disabled.

The legacy `POST /api/feature-flags` route now uses this wrapper, so ceilings and audit apply there too.

## HTTP

| Method | Path | Action |
| --- | --- | --- |
| GET, POST | `/api/platform/features` | `platform.manage` — list / set platform flag `{feature, enabled, expectedRevision}` |
| GET | `/api/platform/features/overrides?feature&organizationId` | `platform.manage` |
| PUT | `/api/platform/features/ceilings` `{organizationId, feature, locked, reason?, expectedRevision}` | `platform.manage` |
| GET | `/api/platform/features/audit` | `platform.manage` |
| GET, PUT | `/api/organizations/{org}/features` `{scope: tenant|event|account, feature, enabled, expectedRevision, eventId?, accountId?}` | `tenant.manage` |

Errors: `feature_locked_by_platform` 403, `revision_conflict` 409, `invalid_feature`/`invalid_feature_scope` 400.

## Pages

* `/platform/features` — platform defaults, tenant overrides/locks, recent audited changes (`platform.manage`).
* `/admin/{org}/features` — effective tenant-wide state with the controlling layer (platform, platform lock, tenant).

## Not claimed

* The LC-08 write commits on its own connection before the audit row commits in the wrapper's
  transaction; a crash between the two would leave an unaudited change (documented gap, not observed in tests).
* Pages are read-only; mutations go through the API.
