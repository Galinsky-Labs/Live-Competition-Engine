import Link from "next/link";
import { getLiveState, readTimer, timerKey } from "@live-competition-engine/db/control-room";
import { listLineup } from "@live-competition-engine/db/registration";
import { listStages } from "@live-competition-engine/db/stages";
import { ActionButton, JsonForm } from "@/components/json-form";
import { LiveView } from "@/components/live-view";
import type { SectionProps } from "@/server/event-sections";

export async function ManageControlRoom({ org, event }: SectionProps) {
  if (event.status !== "live" && event.status !== "paused") return null;
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const stage = (await listStages(org.id, event.id)).find(s => s.status === "live");
  const lineup = stage ? await listLineup(org.id, event.id, stage.id) : [];
  const live = await getLiveState(org.id, event.id);
  const current = lineup.find(s => s.status === "live");
  const timer = current ? await readTimer(org.id, event, timerKey("performance", current.performanceId)) : null;
  const tb = current ? `${base}/performances/${current.performanceId}/timer` : "";
  return (
    <section className="card" aria-labelledby="cr-h">
      <h2 id="cr-h">Control room</h2>
      <p className="muted">Broadcast graphics: <Link href={`/o/${org.slug}/events/${event.id}/broadcast`}>/broadcast</Link> · Green room: <Link href={`/o/${org.slug}/events/${event.id}/backstage`}>/backstage</Link></p>
      <div className="card"><LiveView endpoint={`${base}/live`} variant="page" /></div>
      {!stage ? <p>Start a stage to run the lineup.</p> : (
        <table>
          <thead><tr><th scope="col">#</th><th scope="col">Entrant</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
          <tbody>{lineup.map(slot => (
            <tr key={slot.performanceId}>
              <td>{slot.ordinal}</td><td>{slot.displayName}</td><td><span className="badge">{slot.status}</span></td>
              <td>
                {slot.status === "queued" && !current ? <ActionButton action={`${base}/performances/${slot.performanceId}/start`} label="Start" /> : null}
                {slot.status === "queued" ? <ActionButton action={`${base}/performances/${slot.performanceId}/skip`} body={{ reason: "Skipped by producer" }} label="Skip" confirm="Skip this performance?" /> : null}
                {slot.status === "live" ? <ActionButton action={`${base}/performances/${slot.performanceId}/complete`} label="Complete" /> : null}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {current && timer ? (
        <p>
          Clock <span className="badge">{timer.status}</span>{" "}
          {timer.status === "running" ? <ActionButton action={tb} body={{ type: "pause", expectedSeq: timer.seq }} label="Pause" /> : null}
          {timer.status === "paused" ? <ActionButton action={tb} body={{ type: "resume", expectedSeq: timer.seq }} label="Resume" /> : null}
          {timer.status === "running" || timer.status === "paused" ? <ActionButton action={tb} body={{ type: "extend", ms: 30_000, expectedSeq: timer.seq }} label="+30s" /> : null}
          {timer.status === "idle" || timer.status === "stopped" ? <ActionButton action={tb} body={{ type: "start", durationMs: (stage?.durationSeconds ?? 180) * 1000 }} label="Start clock" /> : null}
        </p>
      ) : null}
      <JsonForm action={`${base}/live-state`} method="PATCH" submitLabel="Update on-air text" fields={[
        { name: "caption", label: "Caption", defaultValue: live.caption ?? "" },
        { name: "overlayMessage", label: "Overlay message", defaultValue: live.overlayMessage ?? "" }
      ]} />
      {live.safetyStopReason ? <p className="error">Safety stop active: {live.safetyStopReason} <ActionButton action={`${base}/live-state`} method="PATCH" body={{ clearSafetyStop: true, overlayMessage: null }} label="Clear notice" /></p> : null}
      {event.status === "live" ? (
        <details><summary>Safety stop</summary>
          <JsonForm action={`${base}/safety-stop`} submitLabel="STOP the show" fields={[{ name: "reason", label: "Reason (logged)", required: true }]} />
        </details>
      ) : null}
    </section>
  );
}

export function PublicLive({ org, event }: SectionProps) {
  if (event.status !== "live" && event.status !== "paused") return null;
  return (
    <section className="card" aria-label="Live now">
      <LiveView endpoint={`/api/organizations/${org.id}/events/${event.id}/live`} variant="page" />
    </section>
  );
}
