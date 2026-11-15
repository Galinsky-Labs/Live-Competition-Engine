import { authorizePage } from "../../../../lib/page-auth";
import { featureControlService } from "../../../../lib/feature-control-services";
import { AccessDenied, AdminShell, tableClass } from "../components";

export const dynamic = "force-dynamic";

const describe = (value: boolean | null) => value === null ? "inherit" : value ? "on" : "off";
const controller = { platform: "Platform setting", ceiling: "Platform lock for this tenant", tenant: "Tenant setting" } as const;

export default async function TenantFeaturesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const auth = await authorizePage("tenant.manage", organizationId);
  if (!auth.ok) return <AccessDenied reason={auth.reason} />;
  const features = await featureControlService.effectiveTenantFeatures(organizationId);
  return (
    <AdminShell organizationId={organizationId} title="Feature flags">
      <p>
        A feature is on only when the platform enables it, the platform has not locked it for this tenant,
        and no tenant, event or account setting turns it off. Change tenant settings with
        <code> PUT /api/organizations/{organizationId}/features</code>.
      </p>
      <table className={tableClass()}>
        <caption className="eyebrow">Effective tenant-wide feature state</caption>
        <thead>
          <tr><th scope="col">Feature</th><th scope="col">Effective</th><th scope="col">Controlled by</th><th scope="col">Platform</th><th scope="col">Tenant</th><th scope="col">Locked</th></tr>
        </thead>
        <tbody>
          {features.map(row => (
            <tr key={row.feature}>
              <th scope="row">{row.feature}</th>
              <td>{row.enabled ? "On" : "Off"}</td>
              <td>{controller[row.controlledBy]}</td>
              <td>{describe(row.platform.enabled)}</td>
              <td>{describe(row.tenant.enabled)}</td>
              <td>{row.ceiling.locked ? `Yes${row.ceiling.reason ? ` — ${row.ceiling.reason}` : ""}` : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </AdminShell>
  );
}
