import { notFound } from "next/navigation";
import { listPublicEvents } from "@live-competition-engine/db/events";
import { findTenantBySlug } from "@live-competition-engine/db/public-tenant";
import styles from "../../public.module.css";
import { formatInZone, STATUS_LABEL } from "./format";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<{ page?: string }>;
};

const PAGE_SIZE = 25;

/** Tenant public event listing: published (non-draft) events with visibility `public`. */
export default async function PublicEventsPage({ params, searchParams }: Props) {
  const { organizationSlug } = await params;
  const pageNumber = Math.min(Math.max(Number.parseInt((await searchParams).page ?? "1", 10) || 1, 1), 400);
  const tenant = await findTenantBySlug(organizationSlug);
  if (!tenant) notFound();
  const events = await listPublicEvents(tenant.id, { limit: PAGE_SIZE + 1, offset: (pageNumber - 1) * PAGE_SIZE });
  const visible = events.slice(0, PAGE_SIZE);

  return (
    <main className={styles.page}>
      <h1>{tenant.name}: events</h1>
      {visible.length === 0 ? (
        <p className={styles.meta}>No public events yet.</p>
      ) : (
        <ul className={styles.list} aria-label="Events">
          {visible.map(event => (
            <li key={event.id}>
              <h2 style={{ margin: 0, fontSize: "1.15rem" }}>
                <a href={`/t/${tenant.slug}/events/${event.slug}`}>{event.title}</a>
              </h2>
              <p className={styles.meta}>
                <span className={styles.tag}>{STATUS_LABEL[event.status] ?? event.status}</span>
                {event.startsAt && (
                  <time dateTime={event.startsAt.toISOString()}>{formatInZone(event.startsAt, event.timezone)}</time>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      <nav aria-label="Pagination">
        {pageNumber > 1 && <a href={`/t/${tenant.slug}/events?page=${pageNumber - 1}`} rel="prev">Previous page</a>}
        {pageNumber > 1 && events.length > PAGE_SIZE && " · "}
        {events.length > PAGE_SIZE && <a href={`/t/${tenant.slug}/events?page=${pageNumber + 1}`} rel="next">Next page</a>}
      </nav>
    </main>
  );
}
