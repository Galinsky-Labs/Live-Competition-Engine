import Link from "next/link";
import { redirect } from "next/navigation";
import { JsonForm } from "@/components/json-form";
import { currentAccount } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const account = await currentAccount();
  if (!account) redirect("/login");
  return (
    <main className="shell">
      <p className="eyebrow">Dashboard</p>
      <h1>Welcome, {account.email}</h1>
      <section aria-labelledby="orgs">
        <h2 id="orgs">Your organizations</h2>
        {account.organizations.length === 0 ? <p>You are not a member of any organization yet.</p> : (
          <ul className="list">
            {account.organizations.map(org => (
              <li key={org.id}>
                <Link href={`/o/${org.slug}`}>{org.name}</Link> <small>{org.roles.join(", ") || "member"}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="new-org" className="card">
        <h2 id="new-org">Create an organization</h2>
        <JsonForm
          action="/api/organizations"
          submitLabel="Create organization"
          fields={[
            { name: "name", label: "Name", required: true },
            { name: "slug", label: "URL slug (lowercase letters, digits, dashes)", required: true }
          ]}
        />
      </section>
    </main>
  );
}
