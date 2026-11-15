import Link from "next/link";
import { listAppeals, listPanel, listRecusals, stageStandings, visibleCritiques } from "@live-competition-engine/db/judging";
import { listEntrants, listStages } from "@live-competition-engine/db/stages";
import { parseContestConfig } from "@live-competition-engine/engine";
import { ActionButton, JsonForm } from "@/components/json-form";
import { pageAccount } from "@/lib/server-auth";
import type { SectionProps } from "@/server/event-sections";

export async function ManageJudging({ org, event }: SectionProps) {
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const panel = await listPanel(org.id, event.id);
  const recusals = await listRecusals(org.id, event.id);
  const names = new Map((await listEntrants(org.id, event.id)).map(e => [e.entryId, e.displayName]));
  const stages = (await listStages(org.id, event.id)).filter(s => s.status === "live" || s.status === "completed");
  const critiques = await visibleCritiques(org.id, event.id, { accountId: null, producer: true });
  const appeals = await listAppeals(org.id, event.id);
  const config = parseContestConfig(event.config);
  return (
    <>
      <section className="card" aria-labelledby="panel-h">
        <h2 id="panel-h">Judging panel ({panel.filter(j => j.status === "accepted").length}/{config.judging.panelSize} accepted)</h2>
        <p className="muted">Judges score at <Link href={`/o/${org.slug}/events/${event.id}/judge`}>the judge console</Link>.</p>
        <ul className="list">
          {panel.map(j => (
            <li key={j.judgeId}>{j.displayName} <span className="badge">{j.status}</span> <small>{j.panel}</small>{" "}
              {j.status === "accepted" || j.status === "invited" ? <ActionButton action={`${base}/judges/${j.judgeId}/remove`} body={{ reason: "Removed by producer" }} label="Remove" confirm="Remove this judge and revoke access?" /> : null}
            </li>
          ))}
        </ul>
        {recusals.length ? <p>Recusals: {recusals.map(r => `${panel.find(j => j.judgeId === r.judge_id)?.displayName ?? "judge"} ↛ ${names.get(r.entry_id) ?? "entry"} (${r.reason})`).join("; ")}</p> : null}
        <JsonForm action={`${base}/judges`} submitLabel="Invite judge" fields={[
          { name: "email", label: "Judge account email", type: "email", required: true },
          { name: "displayName", label: "Display name" },
          { name: "panel", label: "Panel", defaultValue: "main" }
        ]} />
      </section>
      {await Promise.all(stages.map(async stage => {
        const standings = await stageStandings(org.id, event.id, stage.id);
        return (
          <section key={stage.id} className="card" aria-label={`Standings for ${stage.label}`}>
            <h2>Live standings: {stage.label}</h2>
            <table>
              <thead><tr><th scope="col">Rank</th><th scope="col">Entrant</th><th scope="col">Score</th><th scope="col">Judges</th><th scope="col">Audience</th><th scope="col">Complete</th></tr></thead>
              <tbody>{standings.map(s => (
                <tr key={s.entryId}><td>{s.rank}</td><td>{names.get(s.entryId)}</td><td>{s.score}</td><td>{s.judgeScore ?? "–"} ({s.judgeCount})</td><td>{s.audienceScore ?? "–"}</td><td>{s.complete ? "yes" : "awaiting judges"}{s.tieBrokenBy ? ` · tie: ${s.tieBrokenBy}` : ""}</td></tr>
              ))}</tbody>
            </table>
          </section>
        );
      }))}
      {config.critiques.enabled ? (
        <section className="card" aria-labelledby="crit-h">
          <h2 id="crit-h">Critiques and appeals</h2>
          <ul className="list">
            {critiques.map(c => (
              <li key={c.id}>
                <strong>{names.get(c.entryId)}</strong> · {c.visibility} · <span className="badge">{c.moderationStatus}</span> — {c.body}{" "}
                {c.moderationStatus !== "approved" ? <ActionButton action={`${base}/critiques/${c.id}`} method="PATCH" body={{ expectedRevision: c.revision, moderationStatus: "approved" }} label="Approve" /> : null}
                {c.moderationStatus !== "hidden" ? <ActionButton action={`${base}/critiques/${c.id}`} method="PATCH" body={{ expectedRevision: c.revision, moderationStatus: "hidden" }} label="Hide" /> : null}
              </li>
            ))}
          </ul>
          {appeals.filter(a => a.status === "open").map(a => (
            <div key={a.id} className="card">
              <p>Appeal: {a.reason}</p>
              <JsonForm action={`${base}/appeals/${a.id}/resolve`} submitLabel="Resolve appeal" fields={[
                { name: "outcome", label: "Outcome", type: "select", options: [{ value: "upheld", label: "Uphold (hide critique)" }, { value: "dismissed", label: "Dismiss" }] },
                { name: "resolution", label: "Resolution note", required: true }
              ]} />
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

export async function PublicCritiques({ org, event }: SectionProps) {
  if (!parseContestConfig(event.config).critiques.enabled) return null;
  const account = await pageAccount();
  const critiques = await visibleCritiques(org.id, event.id, { accountId: account?.accountId ?? null, producer: false });
  if (!critiques.length) return null;
  const names = new Map((await listEntrants(org.id, event.id)).map(e => [e.entryId, e]));
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  return (
    <section aria-labelledby="pc-h">
      <h2 id="pc-h">Judge feedback</h2>
      <ul className="list">
        {critiques.map(c => {
          const mine = account && names.get(c.entryId)?.accountId === account.accountId;
          return (
            <li key={c.id} className="card">
              <p><strong>{names.get(c.entryId)?.displayName}</strong>{c.visibility !== "public" ? <span className="badge"> visible to you only</span> : null}</p>
              <p>{c.body}</p>
              {mine ? <details><summary>Appeal this feedback</summary><JsonForm action={`${base}/critiques/${c.id}/appeal`} submitLabel="Submit appeal" fields={[{ name: "reason", label: "Why is it wrong or unfair?", type: "textarea", required: true }]} /></details> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
