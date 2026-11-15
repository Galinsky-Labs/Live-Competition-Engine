import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getEvent } from "@live-competition-engine/db/events";
import { findOrganizationBySlug } from "@live-competition-engine/db/organizations";
import { listEntrants } from "@live-competition-engine/db/stages";
import { backstageRole, listBackstage, listReadiness } from "@live-competition-engine/db/streams-backstage";
import { JsonForm } from "@/components/json-form";
import { pageAccount, pagePrincipal } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

export default async function BackstagePage({ params }: { params: Promise<{ slug: string; eventId: string }> }) {
  const { slug, eventId } = await params;
  const org = await findOrganizationBySlug(slug);
  if (!org) notFound();
  const account = await pageAccount();
  if (!account) redirect("/login");
  const event = await getEvent(org.id, eventId);
  if (!event) notFound();
  const producer = Boolean(await pagePrincipal("event.manage", { organizationId: org.id, competitionId: event.id }).catch(() => null));
  const who = await backstageRole(org.id, event.id, account.accountId, producer);
  if (!who) notFound();
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const messages = await listBackstage(org.id, event.id, who);
  const readiness = await listReadiness(org.id, event.id, who);
  const entrants = (await listEntrants(org.id, event.id)).filter(e => e.status === "approved" && (who.role === "producer" || who.entryIds.includes(e.entryId)));
  const audiences = who.role === "producer" ? ["everyone_backstage", "performers", "judges", "crew"] : who.role === "judge" ? ["judges"] : ["crew"];
  return (
    <main className="shell">
      <p className="eyebrow"><Link href={`/o/${org.slug}/events/${event.id}`}>{event.title}</Link> · green room ({who.role})</p>
      <h1>Backstage</h1>
      {who.role !== "judge" ? (
        <section className="card" aria-labelledby="ready-h">
          <h2 id="ready-h">Readiness</h2>
          <ul className="list">{entrants.map(e => <li key={e.entryId}>{e.displayName}: <span className="badge">{readiness.find(r => r.entryId === e.entryId)?.status ?? "not reported"}</span> {readiness.find(r => r.entryId === e.entryId)?.note ?? ""}</li>)}</ul>
          <JsonForm action={`${base}/readiness`} submitLabel="Update readiness" fields={[
            { name: "entryId", label: "Entrant", type: "select", options: entrants.map(e => ({ value: e.entryId, label: e.displayName })) },
            { name: "status", label: "Status", type: "select", options: ["ready", "not_ready", "technical_issue", ...(who.role === "producer" ? ["on_stage"] : [])].map(v => ({ value: v, label: v.replace("_", " ") })) },
            { name: "note", label: "Note" }
          ]} />
        </section>
      ) : null}
      <section className="card" aria-labelledby="msg-h">
        <h2 id="msg-h">Messages and cues</h2>
        <JsonForm action={`${base}/backstage`} submitLabel="Send" fields={[
          { name: "audience", label: "To", type: "select", options: audiences.map(a => ({ value: a, label: a.replaceAll("_", " ") })) },
          ...(who.role === "producer" ? [{ name: "kind", label: "Type", type: "select" as const, options: [{ value: "message", label: "Message" }, { value: "cue", label: "Cue" }] }] : []),
          { name: "body", label: "Message", type: "textarea", required: true }
        ]} />
        <ul className="list" aria-live="polite">
          {messages.map(m => <li key={m.id}>{m.kind === "cue" ? <span className="badge">CUE</span> : null} <strong>{m.authorRole}</strong> → {m.audience.replaceAll("_", " ")}: {m.body} <small className="muted">{m.createdAt.toISOString().slice(11, 19)}Z</small></li>)}
        </ul>
      </section>
    </main>
  );
}
