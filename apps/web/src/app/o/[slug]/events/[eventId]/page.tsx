import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent, getPublicEvent } from "@live-competition-engine/db/events";
import { findOrganizationBySlug } from "@live-competition-engine/db/organizations";
import { parseContestConfig } from "@live-competition-engine/engine";
import { formatInZone } from "@/lib/format";
import { pagePrincipal } from "@/lib/server-auth";
import { eventSections } from "@/server/event-sections";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ slug: string; eventId: string }> }) {
  const { slug, eventId } = await params;
  const org = await findOrganizationBySlug(slug);
  if (!org) notFound();
  const manager = await pagePrincipal("event.manage", { organizationId: org.id, competitionId: eventId }).catch(() => null);
  const event = manager ? await getEvent(org.id, eventId) : await getPublicEvent(org.id, eventId);
  if (!event) notFound();
  const config = parseContestConfig(event.config);
  return (
    <main className="shell">
      <p className="eyebrow"><Link href={`/o/${org.slug}`}>{org.name}</Link></p>
      <h1>{event.title}</h1>
      <p><span className="badge">{event.status}</span>{event.status === "cancelled" && event.cancelReason ? <> Cancelled: {event.cancelReason}</> : null}</p>
      <dl className="grid">
        <div><dt>Starts</dt><dd>{formatInZone(event.startsAt, event.timezone)}</dd></div>
        {event.endsAt ? <div><dt>Ends</dt><dd>{formatInZone(event.endsAt, event.timezone)}</dd></div> : null}
        <div><dt>Where</dt><dd>{event.venue ? `${event.venue.name}${event.venue.address ? `, ${event.venue.address}` : ""}` : null}{event.venue && event.remote ? " and " : null}{event.remote ? "Online stream" : null}</dd></div>
        {event.capacity ? <div><dt>Capacity</dt><dd>{event.capacity}</dd></div> : null}
        <div><dt>Format</dt><dd>{config.format.replaceAll("_", " ")}</dd></div>
      </dl>
      {event.venue?.accessibilityNotes ? <p><strong>Accessibility:</strong> {event.venue.accessibilityNotes}</p> : null}
      {event.description ? <p className="lede">{event.description}</p> : null}
      {manager ? <p><Link href={`/o/${org.slug}/events/${event.id}/manage`}>Open producer console</Link></p> : null}
      {eventSections.public.map((Section, i) => <Section key={i} org={org} event={event} />)}
    </main>
  );
}
