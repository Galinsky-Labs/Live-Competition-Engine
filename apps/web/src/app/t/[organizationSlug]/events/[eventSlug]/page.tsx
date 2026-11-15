import { notFound } from "next/navigation";
import { getPublicEvent } from "@live-competition-engine/db/events";
import { findTenantBySlug } from "@live-competition-engine/db/public-tenant";
import styles from "../../../public.module.css";
import { formatInZone, STATUS_LABEL } from "../format";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ organizationSlug: string; eventSlug: string }> };

/** Accessible public event detail. Drafts, private and members-only events are 404 here. */
export default async function PublicEventPage({ params }: Params) {
  const { organizationSlug, eventSlug } = await params;
  const tenant = await findTenantBySlug(organizationSlug);
  if (!tenant) notFound();
  const event = await getPublicEvent(tenant.id, eventSlug, false);
  if (!event) notFound();
  const starts = formatInZone(event.startsAt, event.timezone);
  const ends = formatInZone(event.endsAt, event.timezone);

  return (
    <main className={styles.page}>
      <nav aria-label="Breadcrumb">
        <a href={`/t/${tenant.slug}/events`}>{tenant.name} events</a>
      </nav>
      <article aria-labelledby="event-title">
        <h1 id="event-title">{event.title}</h1>
        <p className={styles.meta}>
          <span className={styles.tag}>{STATUS_LABEL[event.status] ?? event.status}</span>
        </p>
        {event.status === "cancelled" && (
          <div className={styles.notice} role="status">
            <p><strong>This event has been cancelled.</strong></p>
            {event.cancelReason && <p>{event.cancelReason}</p>}
          </div>
        )}
        {event.description && <p>{event.description}</p>}
        <h2>Details</h2>
        <dl className={styles.details}>
          {starts && event.startsAt && (
            <>
              <dt>Starts</dt>
              <dd><time dateTime={event.startsAt.toISOString()}>{starts}</time></dd>
            </>
          )}
          {ends && event.endsAt && (
            <>
              <dt>Ends</dt>
              <dd><time dateTime={event.endsAt.toISOString()}>{ends}</time></dd>
            </>
          )}
          <dt>Time zone</dt>
          <dd>{event.timezone}</dd>
          {event.venueName && (
            <>
              <dt>Venue</dt>
              <dd>
                {event.venueName}
                {event.venueAddress && <address style={{ fontStyle: "normal" }}>{event.venueAddress}</address>}
              </dd>
            </>
          )}
          {event.streamUrl && (
            <>
              <dt>Online</dt>
              <dd><a href={event.streamUrl} rel="noopener noreferrer">Watch the stream</a></dd>
            </>
          )}
          {event.capacity !== null && (
            <>
              <dt>Capacity</dt>
              <dd>{event.capacity.toLocaleString("en")}</dd>
            </>
          )}
        </dl>
      </article>
    </main>
  );
}
