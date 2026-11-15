import Link from "next/link";
import { getStream } from "@live-competition-engine/db/streams-backstage";
import { selectStreamingProvider } from "@live-competition-engine/engine";
import { ActionButton, JsonForm } from "@/components/json-form";
import type { SectionProps } from "@/server/event-sections";

export async function PublicStream({ org, event }: SectionProps) {
  const stream = await getStream(org.id, event.id);
  if (!stream) return null;
  const src = stream.status === "ended" ? stream.recordingUrl ?? null : stream.embedUrl;
  return (
    <section aria-labelledby="watch-h">
      <h2 id="watch-h">Watch</h2>
      <p>Stream: <span className="badge">{stream.status === "failed" ? "interrupted — we are reconnecting" : stream.status}</span></p>
      {src && stream.status !== "failed" && src.startsWith("https://") ? (
        <iframe title={`${event.title} live stream`} src={src} style={{ width: "100%", aspectRatio: "16 / 9", border: 0 }}
          allow="autoplay; fullscreen; picture-in-picture" sandbox="allow-scripts allow-same-origin allow-presentation" />
      ) : null}
    </section>
  );
}

export async function ManageStream({ org, event }: SectionProps) {
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const stream = await getStream(org.id, event.id);
  const provider = selectStreamingProvider(process.env).id;
  const rev = { expectedRevision: stream?.revision };
  return (
    <section className="card" aria-labelledby="stream-h">
      <h2 id="stream-h">Stream</h2>
      <p className="muted">Provider mode: <strong>{provider}</strong>{provider === "disabled" ? " — set STREAMING_PROVIDER=external_embed (no keys) or mux (MUX_TOKEN_ID/MUX_TOKEN_SECRET) to enable." : ""}</p>
      <p><Link href={`/o/${org.slug}/events/${event.id}/backstage`}>Open green room</Link></p>
      {stream ? (
        <>
          <p>Status <span className="badge">{stream.status}</span> via {stream.provider}{stream.failureReason ? ` — ${stream.failureReason}` : ""}{stream.ingestUrl ? ` · ingest ${stream.ingestUrl}` : ""}</p>
          {stream.status !== "live" ? <ActionButton action={`${base}/stream/status`} body={{ ...rev, status: "live" }} label="Mark live" /> : null}
          {stream.status === "live" || stream.status === "failed" ? <ActionButton action={`${base}/stream/status`} body={{ ...rev, status: "ended" }} label="End stream" /> : null}
          {stream.status === "live" || stream.status === "idle" ? (
            <JsonForm action={`${base}/stream/status`} submitLabel="Report failure" extra={{ ...rev, status: "failed" }} fields={[{ name: "reason", label: "What failed?", required: true }]} />
          ) : null}
        </>
      ) : null}
      {provider !== "disabled" ? (
        <JsonForm action={`${base}/stream`} method="PUT" submitLabel={stream ? "Reconfigure stream" : "Set up stream"} fields={provider === "external_embed" ? [
          { name: "embedUrl", label: "Player embed URL (https, allow-listed host)", type: "url", required: true }
        ] : []} />
      ) : null}
    </section>
  );
}
