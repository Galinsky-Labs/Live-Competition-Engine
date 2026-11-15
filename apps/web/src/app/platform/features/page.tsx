import { authorizePage } from "../../../lib/page-auth";
import { featureControlService } from "../../../lib/feature-control-services";
import styles from "../../admin/[organizationId]/admin.module.css";

export const dynamic = "force-dynamic";

type PlatformRow = { feature: string; enabled: boolean | null; revision: number };
type OverrideRow = { organizationId: string; organizationName: string; feature: string; tenant: { enabled: boolean | null }; ceiling: { locked: boolean; reason: string | null } };

export default async function PlatformFeaturesPage() {
  const auth = await authorizePage("platform.manage");
  if (!auth.ok) {
    return (
      <main className={styles.console}>
        <h1>Access denied</h1>
        <p role="alert">{auth.reason === "unauthenticated" ? "Sign in as a platform operator." : "Platform operators only."}</p>
      </main>
    );
  }
  const [platform, overrides, audit] = await Promise.all([
    featureControlService.listPlatformFeatures() as Promise<PlatformRow[]>,
    featureControlService.listTenantOverrides({ limit: 500 }) as Promise<OverrideRow[]>,
    featureControlService.listFeatureAudit(null) as Promise<Array<{ sequence: string; action: string; subject_id: string; recorded_at: Date }>>
  ]);
  return (
    <main className={styles.console}>
      <p className="eyebrow">Platform administration</p>
      <h1>Feature families</h1>
      <p>Changes are made through <code>/api/platform/features</code> and are audited.</p>
      <section aria-labelledby="platform-heading">
        <h2 id="platform-heading">Platform defaults</h2>
        <table className={styles.table}>
          <thead><tr><th scope="col">Feature</th><th scope="col">Platform</th><th scope="col">Revision</th></tr></thead>
          <tbody>
            {platform.map(row => (
              <tr key={row.feature}><th scope="row">{row.feature}</th><td>{row.enabled === null ? "unset (off)" : row.enabled ? "on" : "off"}</td><td>{row.revision}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section aria-labelledby="overrides-heading">
        <h2 id="overrides-heading">Tenant overrides and locks</h2>
        {overrides.length === 0 ? <p>No tenant overrides.</p> : (
          <table className={styles.table}>
            <thead><tr><th scope="col">Tenant</th><th scope="col">Feature</th><th scope="col">Tenant setting</th><th scope="col">Platform lock</th></tr></thead>
            <tbody>
              {overrides.map(row => (
                <tr key={`${row.organizationId}:${row.feature}`}>
                  <td>{row.organizationName}</td><td>{row.feature}</td>
                  <td>{row.tenant.enabled === null ? "inherit" : row.tenant.enabled ? "on" : "off"}</td>
                  <td>{row.ceiling.locked ? `locked${row.ceiling.reason ? ` — ${row.ceiling.reason}` : ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="audit-heading">
        <h2 id="audit-heading">Recent changes</h2>
        <ol>
          {audit.map(event => <li key={event.sequence}>{event.action} {event.subject_id} at {new Date(event.recorded_at).toISOString()}</li>)}
        </ol>
      </section>
    </main>
  );
}
