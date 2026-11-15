import Link from "next/link";
import { notFound } from "next/navigation";
import { listEvents } from "@live-competition-engine/db/events";
import { findOrganizationBySlug } from "@live-competition-engine/db/organizations";
import { JsonForm } from "@/components/json-form";
import { formatInZone } from "@/lib/format";
import { pagePrincipal } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export default async function OrganizationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await findOrganizationBySlug(slug);
  if (!org) notFound();
  const manager = await pagePrincipal("event.manage", { organizationId: org.id });
  const events = await listEvents(org.id, { includeDrafts: Boolean(manager) });
  return (
    <main className="shell">
      <p className="eyebrow">{org.name}</p>
      <h1>Events</h1>
      {events.length === 0 ? <p>No events yet.</p> : (
        <ul className="list">
          {events.map(event => (
            <li key={event.id}>
              <Link href={`/o/${org.slug}/events/${event.id}`}>{event.title}</Link>{" "}
              <span className="badge">{event.status}</span>{" "}
              <small>{formatInZone(event.startsAt, event.timezone)}</small>
              {manager ? <> · <Link href={`/o/${org.slug}/events/${event.id}/manage`}>Manage</Link></> : null}
            </li>
          ))}
        </ul>
      )}
      {manager ? (
        <section className="card" aria-labelledby="new-event">
          <h2 id="new-event">Create an event</h2>
          <JsonForm
            action={`/api/organizations/${org.id}/events`}
            submitLabel="Create draft event"
            fields={[
              { name: "title", label: "Title", required: true },
              { name: "description", label: "Description", type: "textarea" },
              { name: "timezone", label: "Time zone (IANA, e.g. America/New_York)", defaultValue: "UTC", required: true },
              { name: "startsAt", label: "Starts", type: "datetime-local" },
              { name: "capacity", label: "Capacity", type: "number", min: 1 },
              { name: "remote", label: "Streamed / remote event", type: "checkbox" }
            ]}
          />
        </section>
      ) : null}
    </main>
  );
}
