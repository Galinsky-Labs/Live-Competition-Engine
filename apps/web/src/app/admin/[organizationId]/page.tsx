import { authorizePage } from "../../../lib/page-auth";
import { tenantAdminService } from "../../../lib/tenant-admin-services";
import { AccessDenied, AdminShell, countsClass, formatDate, noticeClass, tableClass } from "./components";

export const dynamic = "force-dynamic";

export default async function TenantAdminOverviewPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const auth = await authorizePage("tenant.manage", organizationId);
  if (!auth.ok) return <AccessDenied reason={auth.reason} />;
  const [shows, moderation, billing] = await Promise.all([
    tenantAdminService.showOverview(organizationId),
    tenantAdminService.moderationSection(organizationId),
    tenantAdminService.billingSection(organizationId)
  ]);
  return (
    <AdminShell organizationId={organizationId} title="Overview">
      <section aria-labelledby="shows-heading">
        <h2 id="shows-heading">Shows</h2>
        <ul className={countsClass()} aria-label="Shows by status">
          {Object.entries(shows.statusCounts).map(([status, count]) => (
            <li key={status}><strong>{count}</strong> {status}</li>
          ))}
        </ul>
        {shows.competitions.length === 0 ? <p>No shows yet.</p> : (
          <table className={tableClass()}>
            <caption className="eyebrow">Most recent shows</caption>
            <thead><tr><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Starts</th><th scope="col">Venue</th><th scope="col">Entries</th></tr></thead>
            <tbody>
              {shows.competitions.map(show => (
                <tr key={show.id}>
                  <td>{show.title}</td><td>{show.status}</td><td>{formatDate(show.startsAt)}</td>
                  <td>{show.venueName ?? "—"}</td><td>{show.entryCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="moderation-heading">
        <h2 id="moderation-heading">Moderation</h2>
        {moderation.status === "ok" ? (
          <ul className={countsClass()}>
            {Object.entries(moderation.data.reports).map(([status, count]) => <li key={status}><strong>{count}</strong> {status} reports</li>)}
            <li><strong>{moderation.data.activeActions}</strong> active takedowns</li>
            <li><strong>{moderation.data.openAppeals}</strong> open appeals</li>
            <li><strong>{moderation.data.activeLegalHolds}</strong> legal holds</li>
          </ul>
        ) : <p className={noticeClass()}>Moderation summary {moderation.status === "unavailable" ? "is temporarily unavailable" : "is not configured"}.</p>}
      </section>
      <section aria-labelledby="billing-heading">
        <h2 id="billing-heading">Billing</h2>
        {billing.status === "ok" ? (
          <dl>
            <dt>Plan</dt><dd>{billing.data.plan ?? "—"}</dd>
            <dt>Outstanding</dt><dd>{billing.data.outstandingMinor} {billing.data.currency ?? ""}</dd>
            <dt>Last invoice</dt><dd>{formatDate(billing.data.lastInvoiceAt)}</dd>
          </dl>
        ) : <p className={noticeClass()}>Billing {billing.status === "unavailable" ? "is temporarily unavailable" : "is not configured for this tenant"}.</p>}
      </section>
    </AdminShell>
  );
}
