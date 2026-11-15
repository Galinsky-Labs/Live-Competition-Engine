import { authorizePage } from "../../../../lib/page-auth";
import { tenantAdminService } from "../../../../lib/tenant-admin-services";
import { AccessDenied, AdminShell, tableClass } from "../components";

export const dynamic = "force-dynamic";

export default async function TenantVenuesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const auth = await authorizePage("tenant.manage", organizationId);
  if (!auth.ok) return <AccessDenied reason={auth.reason} />;
  const venues = await tenantAdminService.listVenues(organizationId, true);
  return (
    <AdminShell organizationId={organizationId} title="Venues">
      {venues.length === 0 ? <p>No venues yet.</p> : (
        <table className={tableClass()}>
          <caption className="eyebrow">Tenant venues</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">Address</th><th scope="col">Capacity</th><th scope="col">Time zone</th><th scope="col">State</th></tr></thead>
          <tbody>
            {venues.map(venue => (
              <tr key={venue.id}>
                <td>{venue.name}</td><td>{venue.address ?? "—"}</td><td>{venue.capacity ?? "—"}</td>
                <td>{venue.timezone ?? "—"}</td><td>{venue.archivedAt ? "archived" : "active"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
