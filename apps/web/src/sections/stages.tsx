import { listEntrants, listMatchups, listStageEntrants, listStages, type MatchupRecord } from "@live-competition-engine/db/stages";
import { ActionButton, JsonForm } from "@/components/json-form";
import type { SectionProps } from "@/server/event-sections";

function Bracket({ matchups, names, manage, base }: { matchups: MatchupRecord[]; names: Map<string, string>; manage: boolean; base: string }) {
  const rounds = [...new Set(matchups.map(m => m.bracketRound))];
  const name = (id: string | null) => (id ? names.get(id) ?? "?" : "TBD");
  return (
    <div className="grid" role="list" aria-label="Bracket">
      {rounds.map(round => (
        <div key={round} role="listitem">
          <h4>Round {round}</h4>
          <ul className="list">
            {matchups.filter(m => m.bracketRound === round).map(m => (
              <li key={m.id}>
                {m.seedA ? `(${m.seedA}) ` : ""}{name(m.entryAId)} vs {m.seedB ? `(${m.seedB}) ` : ""}{name(m.entryBId)}{" "}
                <span className="badge">{m.status === "decided" ? `winner: ${name(m.winnerEntryId)}` : m.status}</span>
                {manage && (m.status === "ready" || m.status === "decided") && m.entryAId && m.entryBId ? (
                  <>
                    {" "}
                    {[m.entryAId, m.entryBId].filter(id => id !== m.winnerEntryId).map(id => (
                      <ActionButton key={id} action={`${base}/matchups/${m.id}/decide`} label={`${m.status === "decided" ? "Correct to" : "Win:"} ${name(id)}`}
                        body={{ winnerEntryId: id, expectedRevision: m.revision, ...(m.status === "decided" ? { reason: "Producer correction" } : {}) }}
                        confirm={m.status === "decided" ? "Correct a recorded result? This is audited." : undefined} />
                    ))}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export async function PublicStages({ org, event }: SectionProps) {
  const stages = await listStages(org.id, event.id);
  if (!stages.length) return null;
  const names = new Map((await listEntrants(org.id, event.id)).map(e => [e.entryId, e.displayName]));
  return (
    <section aria-labelledby="stages-h">
      <h2 id="stages-h">Stages</h2>
      {await Promise.all(stages.map(async stage => {
        const matchups = stage.format === "head_to_head" || stage.format === "round_robin" ? await listMatchups(org.id, event.id, stage.id) : [];
        const entrants = await listStageEntrants(org.id, event.id, stage.id);
        return (
          <article key={stage.id} className="card">
            <h3>{stage.ordinal}. {stage.label} <span className="badge">{stage.status}</span></h3>
            <p className="muted">{stage.kind}{stage.timed && stage.durationSeconds ? ` · ${Math.round(stage.durationSeconds / 60)} min` : ""}</p>
            {matchups.length ? <Bracket matchups={matchups} names={names} manage={false} base="" /> : entrants.length ? (
              <ol>{entrants.map(e => <li key={e.entryId}>{e.displayName} {e.status !== "active" ? <span className="badge">{e.status}</span> : null}</li>)}</ol>
            ) : null}
          </article>
        );
      }))}
    </section>
  );
}

export async function ManageStages({ org, event }: SectionProps) {
  const base = `/api/organizations/${org.id}/events/${event.id}`;
  const entrants = await listEntrants(org.id, event.id);
  const stages = await listStages(org.id, event.id);
  const names = new Map(entrants.map(e => [e.entryId, e.displayName]));
  const approved = entrants.filter(e => e.status === "approved").map(e => e.entryId);
  return (
    <>
      <section className="card" aria-labelledby="entrants-h">
        <h2 id="entrants-h">Entrants ({approved.length} approved)</h2>
        <table>
          <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Entry id</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            {entrants.map(e => (
              <tr key={e.entryId}>
                <td>{e.displayName}{e.members.length ? ` (${e.members.join(", ")})` : ""}</td><td>{e.kind}</td><td>{e.status}</td><td><code>{e.entryId}</code></td>
                <td>{e.status === "approved" ? <ActionButton action={`${base}/entrants/${e.entryId}/status`} body={{ status: "withdrawn" }} label="Withdraw" confirm="Withdraw this entrant?" /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <JsonForm action={`${base}/entrants`} submitLabel="Add entrant" fields={[
          { name: "displayName", label: "Display name", required: true },
          { name: "kind", label: "Kind", type: "select", options: [{ value: "individual", label: "Individual" }, { value: "group", label: "Group" }] },
          { name: "membersJson", label: "Group members JSON (e.g. [\"A\",\"B\"])", type: "text" }
        ]} />
      </section>
      <section className="card" aria-labelledby="stages-m">
        <h2 id="stages-m">Stages</h2>
        {await Promise.all(stages.map(async stage => {
          const sb = `${base}/stages/${stage.id}`;
          const rev = { expectedRevision: stage.revision };
          const stageEntrants = await listStageEntrants(org.id, event.id, stage.id);
          const matchups = await listMatchups(org.id, event.id, stage.id);
          const later = stages.filter(s => s.ordinal > stage.ordinal && s.status === "scheduled");
          return (
            <article key={stage.id} className="card">
              <h3>{stage.ordinal}. {stage.label} <span className="badge">{stage.status}</span> <small className="muted">{stage.format} · advancement: {stage.advancement.type}</small></h3>
              {stage.status === "scheduled" ? <ActionButton action={`${sb}/start`} body={rev} label="Start stage" /> : null}
              {stage.status === "live" ? <ActionButton action={`${sb}/complete`} body={rev} label="Complete stage" /> : null}
              {stage.status === "scheduled" || stage.status === "live" ? <ActionButton action={`${sb}/cancel`} body={rev} label="Cancel stage" confirm="Cancel this stage?" /> : null}
              <p>Entrants: {stageEntrants.map(e => `${e.seed ? `#${e.seed} ` : ""}${e.displayName} (${e.status})`).join(", ") || "none"}</p>
              {stage.status === "scheduled" && !matchups.length ? (
                <JsonForm action={`${sb}/entrants`} method="PUT" submitLabel="Set stage entrants (in seed order)" fields={[
                  { name: "entryIdsJson", label: "Entry ids JSON array", type: "textarea", defaultValue: JSON.stringify(stageEntrants.length ? stageEntrants.map(e => e.entryId) : approved) }
                ]} />
              ) : null}
              {(stage.format === "head_to_head" || stage.format === "round_robin") && !matchups.length && stage.status === "scheduled" ? <ActionButton action={`${sb}/bracket`} label="Generate bracket" /> : null}
              {matchups.length ? <Bracket matchups={matchups} names={names} manage={stage.status === "live"} base={base} /> : null}
              {stage.status === "completed" && later.length ? (
                <JsonForm action={`${sb}/advance`} submitLabel="Advance entrants" fields={[
                  { name: "toStageId", label: "Into stage", type: "select", options: later.map(s => ({ value: s.id, label: s.label })) },
                  { name: "rankingJson", label: "Ranking override JSON (entry ids best first; leave empty to use scores)", type: "textarea" },
                  { name: "selectionJson", label: "Manual selection JSON (manual rule only)", type: "textarea" }
                ]} />
              ) : null}
            </article>
          );
        }))}
        <h3>Add a stage</h3>
        <JsonForm action={`${base}/stages`} submitLabel="Add stage" fields={[
          { name: "label", label: "Label", required: true },
          { name: "kind", label: "Kind", type: "select", options: ["round", "audition", "qualifier", "heat", "semifinal", "final", "showcase", "custom"].map(v => ({ value: v, label: v })) },
          { name: "format", label: "Format", type: "select", options: ["lineup", "head_to_head", "round_robin", "group"].map(v => ({ value: v, label: v.replaceAll("_", " ") })) },
          { name: "timed", label: "Timed", type: "checkbox" },
          { name: "durationSeconds", label: "Duration (seconds)", type: "number", min: 1 },
          { name: "advancementJson", label: "Advancement JSON", type: "text", defaultValue: "{\"type\":\"none\"}", help: "{\"type\":\"top_n\",\"count\":4} · {\"type\":\"threshold\",\"minScore\":7} · {\"type\":\"manual\"} · {\"type\":\"bracket_winners\"}" }
        ]} />
      </section>
    </>
  );
}
