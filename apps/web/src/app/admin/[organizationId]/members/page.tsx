import { authorizePage } from "../../../../lib/page-auth";
import { tenantAdminService } from "../../../../lib/tenant-admin-services";
import { AccessDenied, AdminShell, formatDate, tableClass } from "../components";

export const dynamic = "force-dynamic";

export default async function TenantMembersPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const auth = await authorizePage("tenant.manage", organizationId);
  if (!auth.ok) return <AccessDenied reason={auth.reason} />;
  const [members, invitations] = await Promise.all([
    tenantAdminService.listMembers(organizationId, { limit: 500 }),
    tenantAdminService.listInvitations(organizationId) as Promise<Array<{ id: string; email: string; status: string; initialRole: string | null; expiresAt: Date }>>
  ]);
  return (
    <AdminShell organizationId={organizationId} title="Members">
      <p>Invite, suspend and grant roles through the tenant administration API; this page is a read-only view.</p>
      <table className={tableClass()}>
        <caption className="eyebrow">Members and active role grants</caption>
        <thead><tr><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Joined</th><th scope="col">Roles</th></tr></thead>
        <tbody>
          {members.map(member => (
            <tr key={member.accountId}>
              <td>{member.email ?? member.accountId}</td>
              <td>{member.status}</td>
              <td>{formatDate(member.joinedAt)}</td>
              <td>
                {member.grants.length === 0 ? "—" : (
                  <ul>
                    {member.grants.map(grant => (
                      <li key={grant.id}>{grant.role}{grant.competitionId ? ` (event ${grant.competitionId.slice(0, 8)})` : ""}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Invitations</h2>
      {invitations.length === 0 ? <p>No invitations.</p> : (
        <table className={tableClass()}>
          <thead><tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th></tr></thead>
          <tbody>
            {invitations.map(invite => (
              <tr key={invite.id}><td>{invite.email}</td><td>{invite.initialRole ?? "member"}</td><td>{invite.status}</td><td>{formatDate(invite.expiresAt)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminShell>
  );
}
