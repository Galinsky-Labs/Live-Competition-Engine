import { authorizePage } from "../../../../lib/page-auth";
import { moderationService } from "../../../../lib/moderation-services";
import type { ReportRecord, ActionRecord } from "@live-competition-engine/db/moderation";
import { AccessDenied, AdminShell, formatDate, tableClass } from "../components";

export const dynamic = "force-dynamic";

export default async function ModerationQueuePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const auth = await authorizePage("tenant.manage", organizationId);
  if (!auth.ok) return <AccessDenied reason={auth.reason} />;
  const [open, triaged, actions, appeals] = await Promise.all([
    moderationService.listReports(organizationId, { status: "open" }) as Promise<ReportRecord[]>,
    moderationService.listReports(organizationId, { status: "triaged" }) as Promise<ReportRecord[]>,
    moderationService.listActions(organizationId, { activeOnly: true }) as Promise<ActionRecord[]>,
    moderationService.listAppeals(organizationId, "open") as Promise<Array<{ id: string; action_id: string; statement: string; created_at: Date }>>
  ]);
  const queue = [...open, ...triaged];
  return (
    <AdminShell organizationId={organizationId} title="Moderation">
      <section aria-labelledby="queue-heading">
        <h2 id="queue-heading">Report queue ({queue.length})</h2>
        {queue.length === 0 ? <p>The queue is empty.</p> : (
          <table className={tableClass()}>
            <thead><tr><th scope="col">Filed</th><th scope="col">Subject</th><th scope="col">Reason</th><th scope="col">Status</th><th scope="col">Details</th></tr></thead>
            <tbody>
              {queue.map(report => (
                <tr key={report.id}>
                  <td>{formatDate(report.createdAt)}</td><td>{report.subjectType} {report.subjectId}</td>
                  <td>{report.reason}</td><td>{report.status}</td><td>{report.details ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="actions-heading">
        <h2 id="actions-heading">Active takedowns and hides ({actions.length})</h2>
        <ul>{actions.map(action => <li key={action.id}>{action.action}: {action.subjectType} {action.subjectId} — {action.reason}</li>)}</ul>
      </section>
      <section aria-labelledby="appeals-heading">
        <h2 id="appeals-heading">Open appeals ({appeals.length})</h2>
        <ul>{appeals.map(appeal => <li key={appeal.id}>{formatDate(appeal.created_at)}: {appeal.statement}</li>)}</ul>
      </section>
    </AdminShell>
  );
}
