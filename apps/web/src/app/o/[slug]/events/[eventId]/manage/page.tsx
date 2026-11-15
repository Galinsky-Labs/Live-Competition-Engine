import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getEvent, listTemplates } from "@live-competition-engine/db/events";
import { findOrganizationBySlug } from "@live-competition-engine/db/organizations";
import { ActionButton, JsonForm } from "@/components/json-form";
import { pagePrincipal } from "@/lib/server-auth";
import { eventSections } from "@/server/event-sections";

export const dynamic = "force-dynamic";

export default async function ManageEventPage({ params }: { params: Promise<{ slug: string; eventId: string }> }) {
  const { slug, eventId } = await params;
  const org = await findOrganizationBySlug(slug);
  if (!org) notFound();
  const principal = await pagePrincipal("event.manage", { organizationId: org.id, competitionId: eventId }).catch(() => null);
  if (!principal) redirect("/login");
  const event = await getEvent(org.id, eventId);
  if (!event) notFound();
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const rev = { expectedRevision: event.revision };
  const templates = principal.role === "tenant_operator" ? await listTemplates(org.id) : [];
  return (
    <main className="shell">
      <p className="eyebrow"><Link href={`/o/${org.slug}/events/${event.id}`}>{event.title}</Link> · producer console</p>
      <h1>Manage event</h1>
      <p>Status <span className="badge">{event.status}</span> · revision {event.revision}</p>
      <section className="card" aria-label="Lifecycle">
        <h2>Lifecycle</h2>
        {event.status === "draft" ? <ActionButton action={`${base}/publish`} body={rev} label="Publish" /> : null}
        {event.status === "published" ? <><ActionButton action={`${base}/unpublish`} body={rev} label="Return to draft" /><ActionButton action={`${base}/go-live`} body={rev} label="Go live" /></> : null}
        {event.status === "live" ? <><ActionButton action={`${base}/pause`} body={rev} label="Pause" /><ActionButton action={`${base}/complete`} body={rev} label="Complete" confirm="Mark the event completed?" /></> : null}
        {event.status === "paused" ? <><ActionButton action={`${base}/resume`} body={rev} label="Resume" /><ActionButton action={`${base}/complete`} body={rev} label="Complete" /></> : null}
        {!["completed", "cancelled"].includes(event.status) ? (
          <JsonForm action={`${base}/cancel`} submitLabel="Cancel event" extra={rev} fields={[{ name: "reason", label: "Cancellation reason (shown publicly)", required: true }]} />
        ) : null}
      </section>
      {event.status === "draft" || event.status === "published" ? (
        <section className="card" aria-label="Details">
          <h2>Details</h2>
          <JsonForm action={base} method="PATCH" submitLabel="Save details" extra={rev} fields={[
            { name: "title", label: "Title", defaultValue: event.title },
            { name: "timezone", label: "Time zone", defaultValue: event.timezone },
            { name: "startsAt", label: "Starts", type: "datetime-local" },
            { name: "endsAt", label: "Ends", type: "datetime-local" },
            { name: "capacity", label: "Capacity", type: "number", min: 1, defaultValue: event.capacity ?? undefined },
            { name: "venueJson", label: "Venue JSON ({\"name\":\"…\",\"address\":\"…\",\"accessibilityNotes\":\"…\"})", type: "textarea", defaultValue: event.venue ? JSON.stringify(event.venue) : "" },
            { name: "remote", label: "Streamed / remote", type: "checkbox", defaultValue: event.remote }
          ]} />
        </section>
      ) : null}
      {event.status === "draft" ? (
        <section className="card" aria-label="Configuration">
          <h2>Contest configuration</h2>
          {event.templateId ? <p className="muted">From template version {event.templateVersion}.</p> : null}
          {templates.length ? (
            <JsonForm action={`${base}/apply-template`} submitLabel="Apply template" extra={rev} fields={[
              { name: "templateId", label: "Template", type: "select", options: templates.map(t => ({ value: t.id, label: `${t.name} (${t.key} v${t.version})` })) }
            ]} />
          ) : null}
          <JsonForm action={`${base}/config`} method="PUT" submitLabel="Save configuration" extra={rev} fields={[
            { name: "configJson", label: "Configuration JSON", type: "textarea", defaultValue: JSON.stringify(event.config, null, 2) }
          ]} />
        </section>
      ) : (
        <details className="card"><summary>Locked configuration</summary><pre>{JSON.stringify(event.config, null, 2)}</pre></details>
      )}
      {eventSections.manage.map((Section, i) => <Section key={i} org={org} event={event} />)}
    </main>
  );
}
