import { notFound } from "next/navigation";
import { getPublicEvent } from "@live-competition-engine/db/events";
import { findOrganizationBySlug } from "@live-competition-engine/db/organizations";
import { LiveView } from "@/components/live-view";

export const dynamic = "force-dynamic";

/** Stream-ready on-air graphics: point a browser source at this page. */
export default async function BroadcastPage({ params }: { params: Promise<{ slug: string; eventId: string }> }) {
  const { slug, eventId } = await params;
  const org = await findOrganizationBySlug(slug);
  if (!org) notFound();
  const event = await getPublicEvent(org.id, eventId);
  if (!event) notFound();
  return (
    <main className="shell broadcast">
      <LiveView endpoint={`/api/organizations/${org.id}/events/${event.id}/live`} variant="overlay" />
    </main>
  );
}
