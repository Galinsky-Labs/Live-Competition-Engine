import { authorizePage } from "../../../../lib/page-auth";
import { whiteLabelEmailService } from "../../../../lib/white-label-email-services";
import { AccessDenied, AdminShell, countsClass, formatDate, tableClass } from "../components";

export const dynamic = "force-dynamic";

type Sender = { id: string; local_part: string; domain: string; from_name: string; status: string; dkim_status: string; return_path_status: string; is_default: boolean; last_checked_at: Date | null };
type Template = { id: string; key: string; active_version: number | null; versions: number };
type Summary = { byStatus: Record<string, number> };

export default async function TenantEmailPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const auth = await authorizePage("tenant.manage", organizationId);
  if (!auth.ok) return <AccessDenied reason={auth.reason} />;
  const [senders, templates, summary] = await Promise.all([
    whiteLabelEmailService.listSenderIdentities(organizationId) as Promise<Sender[]>,
    whiteLabelEmailService.listTemplates(organizationId) as Promise<Template[]>,
    whiteLabelEmailService.deliverabilitySummary(organizationId) as Promise<Summary>
  ]);
  return (
    <AdminShell organizationId={organizationId} title="Email">
      <section aria-labelledby="senders-heading">
        <h2 id="senders-heading">Sender identities</h2>
        {senders.length === 0 ? <p>No sender identities. Email is sent from the platform default address.</p> : (
          <table className={tableClass()}>
            <thead><tr><th scope="col">From</th><th scope="col">Status</th><th scope="col">DKIM</th><th scope="col">Return path</th><th scope="col">Default</th><th scope="col">Last checked</th></tr></thead>
            <tbody>
              {senders.map(sender => (
                <tr key={sender.id}>
                  <td>{sender.from_name} &lt;{sender.local_part}@{sender.domain}&gt;</td><td>{sender.status}</td>
                  <td>{sender.dkim_status}</td><td>{sender.return_path_status}</td><td>{sender.is_default ? "Yes" : "No"}</td>
                  <td>{formatDate(sender.last_checked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="templates-heading">
        <h2 id="templates-heading">Templates</h2>
        {templates.length === 0 ? <p>No tenant templates; built-in defaults are used.</p> : (
          <ul>{templates.map(template => <li key={template.id}>{template.key} — active version {template.active_version ?? "none"} of {template.versions}</li>)}</ul>
        )}
      </section>
      <section aria-labelledby="deliverability-heading">
        <h2 id="deliverability-heading">Deliverability (last 30 days)</h2>
        <ul className={countsClass()}>
          {Object.entries(summary.byStatus).length === 0 ? <li>No email sent</li> :
            Object.entries(summary.byStatus).map(([status, count]) => <li key={status}><strong>{count}</strong> {status}</li>)}
        </ul>
      </section>
    </AdminShell>
  );
}
